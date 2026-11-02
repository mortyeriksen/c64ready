// Spec tests for the Great Giana Sisters achievement set
// (server/sets/giana-sisters.json, Time Warp 1987, on the OneLoad64 v5 cartridge).
// One player is $1544 = 1. The title loop stores 0 there, and pressing 1 sets it
// on the same frame the level becomes 1, lives become 3 and the score is still 0.
// $20 is the stage, binary: 1 is stage 1. Clearing stage N makes it N+1.
// The title leaves $20 at 2, so a clear is the change, not the value.
// $043c is lives. A one-player game starts at 3. Losing a life decrements it,
// and the game continues while it stays below 128. The last life goes from 0 to 255.
// $0434 is the dream crystals, BCD. The first one makes it 1. The one after 0x99
// wraps it to 0 and adds a life in that same moment.
// The score is three BCD bytes, $0437 then $0436 then $0435. The HUD prints
// those six digits. 0x000025 is 25, 0x001000 is 1000, 0x012345 is 12345.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/giana-sisters.json'), 'utf8')), 'giana-sisters.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '0a833f8c48f1646bc1bf3ac2c249f9f0';
const LEVEL = 0x20, LIVES = 0x043c, GEMS = 0x0434, ONE = 0x1544;
const SCORE = [0x0437, 0x0436, 0x0435];

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

function setScore(n) {
  const d = String(n).padStart(6, '0');
  ram[SCORE[0]] = parseInt(d.slice(0, 2), 16);
  ram[SCORE[1]] = parseInt(d.slice(2, 4), 16);
  ram[SCORE[2]] = parseInt(d.slice(4, 6), 16);
}

/** Title, then the one frame that starts a one-player game on stage 1. */
function begin() {
  fresh();
  ram[ONE] = 0;
  ram[LEVEL] = 2;
  ram[LIVES] = 0;
  frames(2);
  ram[ONE] = 1;
  ram[LIVES] = 3;
  ram[LEVEL] = 1;
  setScore(0);
  ram[GEMS] = 0;
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge and its one score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.url === 'https://www.lemon64.com/game/great-giana-sisters', 'the set links the game on Lemon64');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE' && set.leaderboards[0].lowerIsBetter === false, 'one score board');
  expect(set.achievements.length >= 8 && set.achievements.length <= 12, 'between 8 and 12 achievements');
  expect(set.achievements.every((a, i) => a.id === i + 1), 'ids are 1..n');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 170, 'the achievements add up to 170 points');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('giana-sisters-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'giana-sisters-crt is not registered in test/external-assets.json';
    try { note = missingNote('giana-sisters-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The title, however the bytes are dressed, unlocks nothing and posts nothing.
{
  fresh();
  ram[ONE] = 0;
  ram[LEVEL] = 2;
  ram[LIVES] = 0;
  ram[GEMS] = 1;
  setScore(50000);
  frames(2);
  ram[LEVEL] = 33;
  ram[LIVES] = 255;
  frames(2);
  expectNames('title dressed up', []);
  expect(starts().length === 0 && submits().length === 0, 'the title does not start or post a score');
  ok('the title and the menu unlock nothing and post nothing');
}

// 4. Pressing 1 starts the board once the stage-1 score is still zero. Nothing unlocks.
{
  begin();
  expectNames('just started', []);
  expect(starts().length === 1 && submits().length === 0, 'the board starts once, with nothing to post');
  ok('a fresh stage starts the board and unlocks nothing');
}

// 5. Dream crystals. Skipping straight to 2 is not the first one.
//    Wrapping 0x99 adds the life. Clearing the counter without a life does not.
{
  begin();
  ram[GEMS] = 2; frames(2);
  expectNames('skipped the first', []);
  ram[GEMS] = 0; frames(1);
  ram[GEMS] = 1; frames(2);
  expectNames('first crystal', ['Sparkle']);

  begin();
  ram[GEMS] = 0x99; frames(2);
  ram[GEMS] = 0; frames(2);
  expectNames('counter cleared, life not gained', []);
  begin();
  ram[GEMS] = 0x99; frames(2);
  ram[LIVES] = 2;
  ram[GEMS] = 0; frames(2);
  expectNames('counter cleared on a death', []);
  begin();
  ram[GEMS] = 0x99; frames(2);
  ram[LIVES] = 4;
  ram[GEMS] = 0; frames(2);
  expectNames('hundredth crystal', ['Crystal Clear']);
  ok('a dream crystal, and the hundredth one');
}

// 6. Stages. Only the step from N to N+1 counts, and stage 1 is not a later stage.
{
  begin();
  expectNames('still on stage 1', []);
  ram[LEVEL] = 4; frames(2);
  expectNames('jumped past stage 1', []);
  begin();
  ram[LEVEL] = 2; frames(2);
  expectNames('cleared stage 1', ['Sweet Dreams']);
  ram[LEVEL] = 6; frames(2);
  expectNames('jumped to stage 6', ['Sweet Dreams']);
  begin();
  ram[LEVEL] = 5; frames(1);
  ram[LEVEL] = 6; frames(2);
  expectNames('cleared stage 5', ['Stage Five']);
  begin();
  ram[LEVEL] = 10; frames(1);
  ram[LEVEL] = 11; frames(2);
  expectNames('cleared stage 10', ['Stage Ten']);
  begin();
  ram[LEVEL] = 20; frames(1);
  ram[LEVEL] = 21; frames(2);
  expectNames('cleared stage 20', ['Stage Twenty']);
  begin();
  ram[LEVEL] = 32; frames(1);
  ram[LEVEL] = 33; frames(2);
  expectNames('cleared stage 32', ['Magic Diamond']);
  begin();
  ram[LIVES] = 2; frames(1);
  ram[LEVEL] = 2; frames(2);
  expectNames('cleared stage 1 down a life', ['Sweet Dreams']);
  begin();
  ram[LIVES] = 255;
  ram[LEVEL] = 2; frames(2);
  expectNames('level ticked on game over', []);
  ok('stage clears, and stage 1 is not a later stage');
}

// 7. Score edges. A jump straight to 50,000 still counts as the smaller ones.
{
  begin();
  setScore(999); frames(2);
  expectNames('999', []);
  setScore(1000); frames(2);
  expectNames('1000', ['Pocket Money']);
  setScore(9999); frames(2);
  expectNames('9999', ['Pocket Money']);
  setScore(10000); frames(2);
  expectNames('10000', ['Pocket Money', 'Ten Grand']);
  setScore(49999); frames(2);
  expectNames('49999', ['Pocket Money', 'Ten Grand']);
  setScore(50000); frames(2);
  expectNames('50000', ['Pocket Money', 'Ten Grand', 'Dream Big']);

  begin();
  setScore(50000); frames(2);
  expectNames('jump', ['Pocket Money', 'Ten Grand', 'Dream Big']);
  ok('score edges, including a jump to 50,000');
}

// 8. Game over posts the score once. A lost life, while the game continues, posts nothing.
{
  begin();
  setScore(1000); frames(2);
  ram[LIVES] = 2; frames(2);
  ram[LIVES] = 1; frames(2);
  ram[LIVES] = 0; frames(2);
  expect(submits().length === 0, 'lives can reach 0 without posting');
  ram[LIVES] = 255; frames(2);
  expect(submits().length === 1 && submits()[0].value === 1000, `game over posts 1000, got ${submits().map((e) => e.value).join(',') || 'nothing'}`);
  setScore(99999); frames(2);
  expect(submits().length === 1, 'the same game over does not post again');

  begin();
  setScore(25); frames(1);
  ram[LIVES] = 0; frames(1);
  ram[LIVES] = 255; frames(2);
  expect(submits().length === 1 && submits()[0].value === 25, `25 posts 25, got ${submits().map((e) => e.value).join(',')}`);

  begin();
  setScore(12345); frames(1);
  ram[LIVES] = 0; frames(1);
  ram[LIVES] = 255; frames(2);
  expect(submits().length === 1 && submits()[0].value === 12345, `12345 posts 12345, got ${submits().map((e) => e.value).join(',')}`);

  begin();
  setScore(50000); frames(1);
  ram[LIVES] = 0; frames(1);
  ram[LIVES] = 255; frames(2);
  expect(submits().length === 1 && submits()[0].value === 50000, `50000 posts 50000, got ${submits().map((e) => e.value).join(',')}`);
  ok('the score posts once when the last life is lost');
}

// 9. A last life with nothing on the board posts nothing.
{
  begin();
  ram[LIVES] = 0; frames(1);
  ram[LIVES] = 255; frames(2);
  expect(submits().length === 0, 'a score of 0 posts nothing');
  expect(starts().length === 1, 'the empty game had still started');
  ok('a score of 0 posts nothing');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - giana sisters set: ${testNo} spec checks`);
