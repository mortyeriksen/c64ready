// Spec tests for the ported Chuckie Egg leaderboard (server/sets/chuckie-egg.json,
// from c64-cheevos, MIT) under rcheevos, on synthesized RAM laid out as the set
// reads it: the score's first five digits at $64-$68 (one value 0-9 per byte;
// the sixth digit on screen is always 0) and lives at $6A (5 at the start of a
// game, 0 at game over).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/chuckie-egg.json'), 'utf8')), 'chuckie-egg.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const SCORE = 0x64, LIVES = 0x6a;

/** The score as the game keeps it: five digit bytes, then a constant 0. */
function setScore(n) {
  const digits = String(Math.floor(n / 10)).padStart(5, '0');
  for (let i = 0; i < 5; i++) ram[SCORE + i] = Number(digits[i]);
}
const lb = [];
function activate() {
  rc.clear(); lb.length = 0;
  return set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
}
function frame() {
  for (const e of rc.doFrame(ram)) if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) lb.push({ ...e });
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const started = () => lb.filter((e) => e.type === EVENT.LBOARD_STARTED).length;
const submitted = () => lb.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);

// 1. The set and its file.
{
  const codes = activate();
  expect(set.achievements.length === 0, 'no achievements: the live c64-cheevos set has none');
  expect(codes.every((c) => c === 0), `the leaderboard parses (codes ${codes})`);
  ok('the high-score leaderboard parses');
}
{
  const file = assetPath('chuckie-egg-crt');
  if (!file) console.log(`ok  - test ${++testNo}: the OneLoad64 cartridge hashes to the listed hash # SKIP ${missingNote('chuckie-egg-crt')}`);
  else {
    const hash = rc.hash(fs.readFileSync(file));
    expect(set.hashes.some((h) => h.hash === hash), `the cartridge's hash ${hash} is listed`);
    ok('the OneLoad64 cartridge hashes to the listed hash');
  }
}

// 2. Title screen: no lives, nothing starts.
{
  activate(); ram.fill(0); setScore(0);
  frames(200);
  expect(started() === 0, 'no attempt starts while lives stay 0');
  ok('nothing starts on the title screen');
}

// 3. A game: lives 0 to 5 starts, score climbs, the last life lost submits.
{
  activate(); ram.fill(0); setScore(0); frames(5);
  ram[LIVES] = 5; frames(2);
  expect(started() === 1, 'lives 0 to 5 starts the attempt');
  setScore(1230); frames(2);
  ram[LIVES] = 4; frames(2);
  expect(submitted().length === 0, 'losing a life is not game over');
  ram[LIVES] = 5; frames(2);
  expect(started() === 1, 'an extra life (4 to 5) does not restart the attempt');
  setScore(45670); frames(2);
  ram[LIVES] = 1; frames(2); ram[LIVES] = 0; frames(1);
  const sub = submitted();
  expect(sub.length === 1 && sub[0].value === 45670, `game over submits the score (got ${sub.map((e) => e.value)})`);
  ok('a game: start, extra life, game over and the score');
}

// 4. Score digits: every digit byte counts at its place value.
{
  activate(); ram.fill(0); setScore(0); frames(3);
  ram[LIVES] = 5; frames(2);
  setScore(987650); frames(2);
  ram[LIVES] = 0; frames(1);
  const sub = submitted();
  expect(sub.length === 1 && sub[0].value === 987650, `987,650 reads back (got ${sub.map((e) => e.value)})`);
  ok('the six-digit score');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - chuckie-egg set: ${testNo} checks`);
