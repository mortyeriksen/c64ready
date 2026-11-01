// Spec tests for the 1943 achievement set (server/sets/1943.json,
// Capcom 1988, on the OneLoad64 v5 cartridge).
// Play is the one-player game: the score routine at $A862 and the copy at
// $A8BA are the unpacked bytes, $9BF7 is 1 once F1 has started the game,
// and $A163 is 0. The title is still packed, and the menu keeps $9BF7 at 0.
// The displayed score is six ASCII digits at $A023 (100000s) through $A028
// (ones). Awards land on the tens digit, so the ones digit stays "0".
// $A165 is the weapon (0 is the gun you start with, 3 and above fires extra
// shots). $9F20 is energy. A life starts full, at 36, and the bar drains.
// A pickup adds at most four, so the frame that fills the bar already held
// 32 to 35. An even section starts by storing 36 in one write, the refill
// between missions, and that jump does not count. A respawn fills it too,
// after the life is already lost. $A161 is lives, 4 at the start, which the
// HUD draws as three icons. $9B90 is 1 while the plane is in the air. $9B6B
// is how many targets are left. The intro count touches 0 before the plane
// spawns. $9B6A is the section. Clearing mission N leaves it at 2*N, so the
// second clear is 4, then 8, 16 and 24. The last mission is section 30.
// Clearing that one wraps the index to 0. The score digits are still there
// when the last life reaches 0.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/1943.json'), 'utf8')), '1943.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '1d5551b18ccd5add43bc8415193d4fdb';
const SCORE = 0xa862, COPY = 0xa8ba, FLAG = 0x9bf7, P2 = 0xa163;
const LIVES = 0xa161, GUN = 0xa165, ENERGY = 0x9f20, TARGETS = 0x9b6b, SECTION = 0x9b6a, ALIVE = 0x9b90;
const DIGITS = [0xa023, 0xa024, 0xa025, 0xa026, 0xa027, 0xa028];

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
  const s = String(n).padStart(6, '0');
  for (let i = 0; i < DIGITS.length; i++) ram[DIGITS[i]] = s.charCodeAt(i);
}

/** One player, just into the level: four lives, a full bar, the plane flying, one target left. */
function begin() {
  fresh();
  ram[SCORE] = 0x85;
  ram[COPY] = 0xa0;
  ram[P2] = 0;
  ram[LIVES] = 4;
  ram[ENERGY] = 36;
  ram[ALIVE] = 1;
  ram[GUN] = 0;
  ram[TARGETS] = 1;
  ram[SECTION] = 0;
  score(0);
  frames(2);
  ram[FLAG] = 1;
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge and its one score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.url === 'https://www.lemon64.com/game/1943-the-battle-of-midway', 'the set links the game on Lemon64');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE', 'one score board');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 275, 'the achievements add up to 275 points');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('1943-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = '1943-crt is not registered in test/external-assets.json';
    try { note = missingNote('1943-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The title and the menu, however the bytes are dressed, unlock nothing.
{
  fresh();
  ram[SCORE] = 0xff;
  ram[COPY] = 0xff;
  ram[FLAG] = 0;
  ram[GUN] = 0xff;
  ram[SECTION] = 0xff;
  ram[ENERGY] = 36;
  ram[LIVES] = 4;
  score(50000);
  frames(4);
  expectNames('packed title', []);
  expect(starts().length === 0 && submits().length === 0, 'the title does not start or post a score');

  fresh();
  ram[SCORE] = 0x85;
  ram[COPY] = 0xa0;
  ram[FLAG] = 0;
  ram[P2] = 0;
  ram[GUN] = 0xff;
  ram[SECTION] = 0xff;
  ram[ENERGY] = 36;
  ram[LIVES] = 4;
  ram[TARGETS] = 0;
  score(3000);
  frames(4);
  expectNames('menu', []);
  expect(starts().length === 0, 'the menu does not start the board');
  ok('the title and the menu unlock nothing and post nothing');
}

// 4. Pressing F1 while the attract score is still up does not start the board.
//    The board starts once the level has zeroed it. A full bar at that moment
//    is the start of the life, not a refill.
{
  fresh();
  ram[SCORE] = 0x85;
  ram[COPY] = 0xa0;
  ram[P2] = 0;
  ram[LIVES] = 4;
  ram[ENERGY] = 36;
  ram[ALIVE] = 1;
  ram[TARGETS] = 1;
  score(3000);
  frames(2);
  ram[FLAG] = 1;
  frames(2);
  expectNames('attract score still showing', []);
  expect(starts().length === 0, 'the board waits until the score is zero');
  score(0);
  frames(2);
  expectNames('level', []);
  expect(starts().length === 1 && submits().length === 0, 'the board starts once, with nothing to post');
  ok('a fresh level starts the board and unlocks nothing');
}

// 5. Score edges. A jump straight to 50,000 still counts as the first points.
{
  begin();
  score(10); frames(2);
  expectNames('10', ['First Strike']);
  score(4990); frames(2);
  expectNames('4990', ['First Strike']);
  score(5000); frames(2);
  expectNames('5000', ['First Strike', 'Special Bonus']);
  score(9990); frames(2);
  expectNames('9990', ['First Strike', 'Special Bonus']);
  score(10000); frames(2);
  expectNames('10000', ['First Strike', 'Special Bonus', 'Clean Run']);
  score(49990); frames(2);
  expectNames('49990', ['First Strike', 'Special Bonus', 'Clean Run']);
  score(50000); frames(2);
  expectNames('50000', ['First Strike', 'Special Bonus', 'Clean Run', 'Ace Pilot']);

  begin();
  score(50000); frames(2);
  expectNames('jump', ['First Strike', 'Special Bonus', 'Clean Run', 'Ace Pilot']);
  ram[LIVES] = 3; score(10000); frames(2);
  begin();
  score(10000); ram[LIVES] = 3; frames(2);
  expectNames('10,000 after a life was lost', ['First Strike', 'Special Bonus']);
  ok('score edges, including a clean 10,000 and a jump to 50,000');
}

// 6. Weapons. 1 is a special gun. 3 and above also fire extra shots.
{
  begin();
  ram[GUN] = 1; frames(2);
  expectNames('weapon 1', ['New Gun']);
  ram[GUN] = 2; frames(2);
  expectNames('weapon 2', ['New Gun']);
  ram[GUN] = 3; frames(2);
  expectNames('weapon 3', ['New Gun', 'Spread Shot']);
  ram[GUN] = 0x0a; frames(2);
  expectNames('weapon 10', ['New Gun', 'Spread Shot']);
  ok('a special weapon, and a multi-shot one');
}

// 7. The bar starts full. A refill counts only when the previous frame was
//    already in the last four points, and the original four lives are intact.
//    A jump from a drained bar is the fill between missions.
{
  begin();
  expectNames('still the starting bar', []);
  ram[ENERGY] = 15; frames(1);
  ram[ENERGY] = 36; frames(2);
  expectNames('jump from a drained bar', []);
  ram[ENERGY] = 31; frames(1);
  ram[ENERGY] = 36; frames(2);
  expectNames('one short of the last chunk', []);
  begin();
  ram[ENERGY] = 32; frames(1);
  ram[ENERGY] = 36; frames(2);
  expectNames('last chunk from 32', ['Full Energy']);
  begin();
  ram[ENERGY] = 35; frames(1);
  ram[ENERGY] = 36; frames(2);
  expectNames('last chunk from 35', ['Full Energy']);
  begin();
  ram[ENERGY] = 35; frames(1);
  ram[LIVES] = 3;
  ram[ENERGY] = 36; frames(2);
  expectNames('refilled after a life was lost', []);
  ok('a refill before the first life is lost');
}

// 8. The last target is the frame the count reaches 0 while the plane is
//    flying. The intro's own count hits 0 before that. Clearing mission N
//    leaves the section at 2*N. The last mission is section 30.
{
  begin();
  ram[ALIVE] = 0;
  ram[TARGETS] = 0; frames(2);
  expectNames('intro count', []);
  begin();
  ram[TARGETS] = 4; frames(2);
  expectNames('targets left', []);
  ram[TARGETS] = 0; frames(2);
  expectNames('targets gone', ['Last Target']);
  ram[TARGETS] = 3; frames(1);
  ram[TARGETS] = 0; frames(2);
  expectNames('a later wave', ['Last Target']);
  begin();
  ram[SECTION] = 1; frames(2);
  expectNames('section 1', []);
  ram[SECTION] = 2; frames(2);
  expectNames('section 2', ['Mission Clear']);
  ram[SECTION] = 3; frames(2);
  expectNames('section 3', ['Mission Clear']);
  ram[SECTION] = 4; frames(2);
  expectNames('section 4', ['Mission Clear', 'Second Mission']);
  ram[SECTION] = 8; frames(2);
  expectNames('section 8', ['Four Missions', 'Mission Clear', 'Second Mission']);
  ram[SECTION] = 16; frames(2);
  expectNames('section 16', ['Eight Missions', 'Four Missions', 'Mission Clear', 'Second Mission']);
  ram[SECTION] = 24; frames(2);
  expectNames('section 24', ['Eight Missions', 'Four Missions', 'Mission Clear', 'Second Mission', 'Twelve Missions']);
  ram[SECTION] = 29; frames(2);
  expectNames('section 29', ['Eight Missions', 'Four Missions', 'Mission Clear', 'Second Mission', 'Twelve Missions']);
  ram[SECTION] = 30; frames(2);
  expectNames('section 30', ['Eight Missions', 'Four Missions', 'Last Mission', 'Mission Clear', 'Second Mission', 'Twelve Missions']);
  begin();
  ram[SECTION] = 30; frames(2);
  expectNames('jump to the last mission', ['Eight Missions', 'Four Missions', 'Last Mission', 'Mission Clear', 'Second Mission', 'Twelve Missions']);
  ok('the last target, and the cleared missions');
}

// 9. The board posts the displayed score when the last life reaches 0.
{
  begin();
  score(2500);
  ram[LIVES] = 1; frames(2);
  ram[LIVES] = 0; frames(2);
  const posted = submits();
  expect(posted.length === 1 && posted[0].value === 2500, `a 2,500 death posts 2500 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);
  begin();
  score(0);
  ram[LIVES] = 1; frames(2);
  ram[LIVES] = 0; frames(2);
  expect(submits().length === 0, 'a score of 0 posts nothing');
  begin();
  score(8000);
  ram[LIVES] = 3; frames(2);
  expect(submits().length === 0, 'losing one life posts nothing');
  ok('the score posts when the plane goes down');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - 1943 set: ${testNo} spec checks`);
