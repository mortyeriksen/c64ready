// Spec tests for the Wizball achievement set (server/sets/wizball.json,
// Sensible Software 1987, on the OneLoad64 v5 cartridge).
// Play is the level, where the kernal IRQ slot at $0314 is 0, the score
// routine at $7110 and the raster IRQ at $7C78 are the unpacked bytes, and
// $BFD8 is 1. The title, the high scores and get-ready keep a different IRQ.
// 1UP is six decimal digits at $BFDB (100000s) through $BFE0 (ones).
// $B12E, $B12F and $B130 are the three cauldrons. $B122, $B123 and $B124
// count the three colours, and 3 means that colour is complete.
// $B27B is player 1's lives. It starts at 3, which the HUD draws as 2, and
// the one-player game ends when it reaches 0. The score digits are still
// there on that frame.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/wizball.json'), 'utf8')), 'wizball.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '24181f379eb31592fe580981d7f68f45';
const IRQ = 0x0314, SCORE = 0x7110, RASTER = 0x7c78, ONE = 0xbfd8;
const LIVES = 0xb27b;
const DIGITS = [0xbfdb, 0xbfdc, 0xbfdd, 0xbfde, 0xbfdf, 0xbfe0];
const POTS = [0xb12e, 0xb12f, 0xb130];
const COLOURS = [0xb122, 0xb123, 0xb124];

const unlocked = new Set();
const boards = [];
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  for (const l of set.leaderboards ?? []) codes.push(rc.activateLeaderboard(l.id, l.definition));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const fresh = () => { activate(); frames(2); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const submits = () => boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
const starts = () => boards.filter((e) => e.type === EVENT.LBOARD_STARTED);

function score(n) {
  for (let i = DIGITS.length - 1; i >= 0; i--) {
    ram[DIGITS[i]] = n % 10;
    n = Math.floor(n / 10);
  }
}

/** The level, just in, with three lives and an empty score. */
function begin() {
  fresh();
  ram[IRQ] = 0;
  ram[SCORE] = 0xac;
  ram[RASTER] = 0x48;
  ram[ONE] = 1;
  ram[LIVES] = 3;
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge and its one score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE', 'one score board');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 150, 'the achievements add up to 150 points');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('wizball-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'wizball-crt is not registered in test/external-assets.json';
    try { note = missingNote('wizball-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The title, with a finished game written over it, unlocks nothing.
{
  fresh();
  ram[IRQ] = 0x31;
  ram[SCORE] = 0x66;
  ram[RASTER] = 0;
  ram[ONE] = 0;
  score(50000);
  for (const a of POTS) ram[a] = 4;
  for (const a of COLOURS) ram[a] = 3;
  ram[LIVES] = 0;
  frames(4);
  expect(names().length === 0, `the title unlocks nothing (got ${names().join(', ')})`);
  expect(starts().length === 0 && submits().length === 0, 'the title posts no score');
  ok('the title unlocks nothing and posts no score');
}

// 4. High scores and get-ready already hold the unpacked code, and still count for nothing.
{
  fresh();
  ram[IRQ] = 0x95;
  ram[SCORE] = 0xac;
  ram[RASTER] = 0x48;
  ram[ONE] = 0;
  score(50000);
  ram[0x71d9] = 0;
  ram[0x71da] = 5;
  ram[LIVES] = 0;
  frames(4);
  expect(names().length === 0, `the high scores unlock nothing (got ${names().join(', ')})`);
  expect(starts().length === 0 && submits().length === 0, '050000 on the high scores posts nothing');

  fresh();
  ram[IRQ] = 0x95;
  ram[SCORE] = 0xac;
  ram[RASTER] = 0x48;
  ram[ONE] = 1;
  ram[LIVES] = 3;
  score(999999);
  for (const a of POTS) ram[a] = 4;
  for (const a of COLOURS) ram[a] = 3;
  ram[LIVES] = 9;
  frames(4);
  expect(names().length === 0, `get-ready unlocks nothing (got ${names().join(', ')})`);
  expect(starts().length === 0 && submits().length === 0, 'get-ready posts no score');
  ok('the high scores and get-ready unlock nothing');
}

// 5. Entering the level opens the board once. An empty score posts nothing.
{
  begin();
  frames(20);
  expect(names().length === 0, `a fresh level unlocks nothing (got ${names().join(', ')})`);
  expect(starts().length === 1, `the board opens once (got ${starts().length})`);
  expect(submits().length === 0, 'a score of zero is not posted');
  ram[0x71da] = 5;
  frames(2);
  expect(names().length === 0, 'the canned 050000 is not the player score');
  ok('the level opens the board and the canned high score does not count');
}

// 6. The score milestones follow the six digits, and a jump from zero counts the first points too.
{
  begin();
  score(10);
  frames(2);
  expectNames('10 points', ['Bounce']);
  score(999);
  frames(2);
  expectNames('999 points', ['Bounce']);
  score(1000);
  frames(2);
  expectNames('1000 points', ['Bounce', 'One Thousand']);
  score(9990);
  frames(2);
  expectNames('9990 points', ['Bounce', 'One Thousand']);
  score(10000);
  frames(2);
  expectNames('10000 points', ['Bounce', 'One Thousand', 'Ten Thousand']);
  score(49990);
  frames(2);
  expectNames('49990 points', ['Bounce', 'One Thousand', 'Ten Thousand']);
  score(50000);
  frames(2);
  expectNames('50000 points', ['Bounce', 'One Thousand', 'Ten Thousand', 'Top Score']);

  begin();
  score(50000);
  frames(2);
  expectNames('jump to 50000', ['Bounce', 'One Thousand', 'Ten Thousand', 'Top Score']);
  ok('the score milestones follow the digits');
}

// 7. One cauldron, then all three. The colour counters are a separate set.
{
  begin();
  ram[POTS[0]] = 1;
  frames(2);
  expectNames('one cauldron', ['Drip Feed']);
  ram[POTS[1]] = 1;
  frames(2);
  expectNames('two cauldrons', ['Drip Feed']);
  ram[POTS[2]] = 1;
  frames(2);
  expectNames('three cauldrons', ['Drip Feed', 'Three Cauldrons']);

  begin();
  ram[COLOURS[0]] = 2;
  frames(2);
  expectNames('a colour at 2', []);
  ram[COLOURS[0]] = 3;
  frames(2);
  expectNames('one colour', ['A Splash of Colour']);
  ram[COLOURS[1]] = 3;
  frames(2);
  expectNames('two colours', ['A Splash of Colour']);
  ram[COLOURS[2]] = 3;
  frames(2);
  expectNames('three colours', ['A Splash of Colour', 'Every Colour']);
  ok('cauldrons and colours count on their own');
}

// 8. An extra life is the stock rising past the 3 you start with.
{
  begin();
  ram[LIVES] = 2;
  frames(2);
  expectNames('a lost life', []);
  ram[LIVES] = 3;
  frames(2);
  expectNames('back to 3', []);
  ram[LIVES] = 4;
  frames(2);
  expectNames('from 3 to 4', ['Extra Life']);

  begin();
  ram[LIVES] = 4;
  frames(2);
  expectNames('straight to 4', ['Extra Life']);
  ram[LIVES] = 5;
  frames(2);
  expectNames('a further life', ['Extra Life']);
  ok('an extra life is a stock above the start');
}

// 9. The board takes the score on the frame the last life is lost, and never takes zero.
{
  begin();
  score(2500);
  frames(2);
  ram[LIVES] = 0;
  frames(2);
  const posted = submits();
  expect(posted.length === 1, `one score posted (got ${posted.length})`);
  expect(posted[0]?.value === 2500, `the posted score is 2500 (got ${posted[0]?.value})`);
  frames(5);
  expect(submits().length === 1, 'the same game does not post again');

  begin();
  ram[LIVES] = 0;
  frames(2);
  expect(submits().length === 0, 'a game with no points posts nothing');
  ram[LIVES] = 2;
  frames(2);
  expect(submits().length === 0, 'losing one life is not the end');
  ok('the score posts when the game ends');
}

if (failing) {
  console.log(`\nnot ok: ${failing} of ${testNo} failed`);
  process.exit(1);
}
console.log(`\nok: ${testNo} tests`);
