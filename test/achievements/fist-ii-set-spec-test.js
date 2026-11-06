// Spec tests for the Fist II achievement set (server/sets/fist-ii.json, Melbourne House 1986, on the
// OneLoad64 cartridge) under rcheevos, on synthesized RAM laid out as the game keeps it:
//   $3527 and $2CCD the game's code. $CC01-$CC06 the score as the top row's characters (0 a blank,
//   1-10 the digits 0-9). $2D32 the lives. $0451 1 for a few frames after the last life is lost, the
//   score already reset to 0 and copied to the hi-score. $048C the opponents defeated since the last
//   meditation. $046A the location's kind (6 a temple). $0405-$040C the scrolls (1 carried, $80 learned).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/fist-ii.json'), 'utf8')), 'fist-ii.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = set.hashes[0].hash;
const OVER = 0x7fffffff;

const unlocked = new Set(), boards = [];
let over = 0;
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; over = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  codes.push(rc.activateLeaderboard(1, set.leaderboards[0].definition));
  codes.push(rc.activateAchievement(OVER, set.gameOver));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) { if (e.id === OVER) over++; else unlocked.add(e.id); }
    else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', '), exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const of = (t) => boards.filter((e) => e.type === t);
const setScore = (n) => ram.set([...String(n).padStart(6, ' ')].map((c) => (c === ' ' ? 0 : +c + 1)), 0xcc01);
const score = (n) => { setScore(n); frames(2); };
const kill = () => { ram[0x48c] = Math.min(ram[0x48c] + 1, 31); frames(2); };
/** A fresh boot: the game's code and its lives in, the score row junk, then reset to 0. */
function boot() {
  activate();
  ram.set([0xee, 0x8c, 0x04, 0xad], 0x3527); ram.set([0xee, 0x32, 0x2d, 0xa9], 0x2ccd);
  ram[0x2d32] = 1; ram.set([0, 0xff, 0xff, 0xff, 0xff, 0], 0xcc01); frames(2);
  score(0);
}
/** The last life lost: the score copied to the hi-score and reset, lives back to 1 for the next game, and $0451 set for a few frames. */
function lastLife() { setScore(0); ram[0x2d32] = 1; ram[0x451] = 1; frames(3); ram[0x451] = 0; frames(2); }
/** Meditation in temple i with its scroll carried: learned, and a life more. */
function meditate(i) { ram[0x405 + i] = 1; frames(2); ram[0x46a] = 6; frames(2); ram[0x405 + i] = 0x80; ram[0x2d32]++; ram[0x48c] = 0; frames(2); ram[0x46a] = 1; frames(2); }

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(/^[0-9a-f]{32}$/.test(HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements, the board and the game over parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('fist-ii-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'fist-ii-crt is not registered in test/external-assets.json';
    try { note = missingNote('fist-ii-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. A long game: victories, temples and all eight scrolls, the scores; the game over posts the score.
{
  boot();
  expectNames('the row\'s junk at boot', []);
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'the score row reset starts the board');
  score(800); kill();
  expectNames('one victory', ['First Victory']);
  for (let i = 0; i < 29; i++) kill();
  for (let i = 0; i < 8; i++) { meditate(i); if (i === 0) expectNames('a temple', ['Fist Master', 'First Victory', 'Marked by the Warlord', 'Sanctuary', 'Seasoned Fighter', 'The First Trigram']); }
  score(4900); expect(!names().includes('5,000'), '4,900 is short of 5,000');
  score(25300);
  lastLife();
  expectNames('the whole game', ['10,000', '25,000', '5,000', 'Fist Master', 'First Victory', 'Four Trigrams', 'Marked by the Warlord', 'Sanctuary', 'Seasoned Fighter',
    'The Eight Trigrams', 'The First Trigram']);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 25300, `25,300 is posted (got ${sub.map((e) => e.value).join(',') || 'nothing'})`);
  expect(over === 1, 'the game is over');
  expect(of(EVENT.LBOARD_STARTED).length === 2, 'the next game starts the board again');
  ok('a long game');
}

// 4. Victories count per game: nine, a game over, then one more is not ten. A game without points posts nothing.
{
  boot();
  for (let i = 0; i < 9; i++) kill();
  lastLife(); ram[0x48c] = 0;
  kill();
  expectNames('nine, then one', ['First Victory']);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0 && of(EVENT.LBOARD_CANCELED).length === 1, 'no points: the board is cancelled');
  ok('victories per game, and a game without points');
}

// 5. Without the game's code nothing counts.
{
  activate(); frames(2);
  ram[0x2d32] = 1; score(90000); ram[0x48c] = 30; ram[0x46a] = 6; ram.fill(0x80, 0x405, 0x40d); frames(2);
  expectNames('no code', []);
  ok('nothing counts without the game');
}

// 6. Each score tier's score is what the board posts for a game ending right at the tier: a
//     post at or above it stays off the public wall until the tier is unlocked.
{
  const tiers = set.achievements.filter((a) => a.score !== undefined);
  expect(tiers.map((a) => a.title).join() === ['5,000', '10,000', '25,000'].join(), `the score tiers (got ${tiers.map((a) => a.title).join()})`);
  for (const a of tiers) {
    boot(); score(a.score); lastLife();
    expect(unlocked.has(a.id), `${a.title} unlocks at ${a.score}`);
    const sub = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED).map((e) => e.value);
    expect(sub.at(-1) === a.score, `${a.title}: a game ending at the tier posts ${a.score} (got ${sub.join(',') || 'nothing'})`);
  }
  ok('score tiers match the board');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Fist II set: ${testNo} spec checks`);
