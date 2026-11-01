// Spec tests for the ported Stix high-score board (server/sets/stix.json, from
// c64-cheevos, MIT) under rcheevos, on synthesized RAM laid out as the set
// reads it: spare lives $4B2D (3 when a game starts, 0 on the last life), the
// BCD score $4B2E (low) to $4B30 (high), and $4B23, which the game zeroes when
// the last life is lost and then counts up on the game over screen; a new game
// keeps whatever it had reached ($FF on the game that starts at power-on).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/stix.json'), 'utf8')), 'stix.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const LIVES = 0x4b2d, SCORE = 0x4b2e, OVER = 0x4b23;
const LOCAL = { 'stix-crt': '19c3b801ad45c756085b080eea14cb3c', 'stix-official-crt': 'e0bf1242e30efc5a97072610a63a1826' };
const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
function setScore(n) { ram[SCORE] = bcd(n % 100); ram[SCORE + 1] = bcd(Math.floor(n / 100) % 100); ram[SCORE + 2] = bcd(Math.floor(n / 10000) % 100); }

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
/** Lives go from 3 down to 0; the last one lost zeroes $4B23. */
function loseAll() {
  for (const l of [2, 1, 0]) { ram[LIVES] = l; frames(5); }
  ram[OVER] = 0; frames(1);
}

// 1. The board parses and names the three releases.
{
  const codes = activate();
  expect(codes.length === 1 && codes[0] === 0, `the high-score board parses (codes ${codes})`);
  expect(set.achievements.length === 0, 'the board only: c64-cheevos has no Stix achievements');
  expect(set.hashes.some((h) => h.hash === 'b4be7e45be496ac3997d74aae2d71a95'), 'the set names c64cade\'s PRG');
  for (const h of Object.values(LOCAL)) expect(set.hashes.some((x) => x.hash === h), `the set names ${h}`);
  ok('the set parses');
}

// 2. The listed cartridge hashes are the local cartridges' rcheevos hashes.
for (const [key, hash] of Object.entries(LOCAL)) {
  const file = assetPath(key);
  if (!file) console.log(`ok  - test ${++testNo}: ${key} hashes to the listed hash # SKIP ${missingNote(key)}`);
  else { expect(rc.hash(fs.readFileSync(file)) === hash, `${key} hashes to ${hash}`); ok(`${key} hashes to the listed hash`); }
}

// 3. A game: lives set to 3 starts it, the last life lost submits the score.
{
  activate(); ram[OVER] = 0xff; frames(5);
  ram[LIVES] = 3; frames(2);
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'lives set to 3 starts the attempt');
  setScore(1442); frames(3);
  loseAll();
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 1442, `the last life lost submits the BCD score 1442 (got ${sub.map((e) => e.value)})`);
  for (const t of [1, 2, 3]) { ram[OVER] = t; frames(30); }
  expect(of(EVENT.LBOARD_TRIGGERED).length === 1, 'the game over screen\'s counter submits nothing more');
  ok('a game is tracked from 3 lives to the last one lost');
}

// 4. The next game keeps the counter's value; it starts and ends the same way.
{
  activate(); ram[OVER] = 4; frames(5);
  setScore(0); ram[LIVES] = 3; frames(2);
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'fire on the game over screen starts the next attempt');
  setScore(123456); frames(2);
  loseAll();
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 123456, `six BCD digits: 123456 submitted (got ${sub.map((e) => e.value)})`);
  ok('a restarted game is tracked the same way');
}

// 5. A game that ends on 0 points is canceled, not submitted.
{
  activate(); frames(3);
  ram[OVER] = 0xff; ram[LIVES] = 3; frames(2);
  loseAll();
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'a game without a point submits nothing');
  expect(of(EVENT.LBOARD_CANCELED).length === 1, 'it is canceled instead');
  ok('an empty game is not submitted');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - stix set: ${testNo} checks`);
