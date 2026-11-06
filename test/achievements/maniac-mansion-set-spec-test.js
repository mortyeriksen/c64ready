// Spec tests for the Maniac Mansion achievement set (server/sets/maniac-mansion.json, the OneLoad64
// "Maniac Mansion & Zak McKracken" EasyFlash cartridge) under rcheevos, on synthesized RAM laid out as
// the game's SCUMM v0 engine keeps it:
//   $FF67 the script variables, a byte each: Var[4] the room shown, Var[18] the meteor (2 in the Edsel,
//         3 taken by the Meteor Police), Var[73] Weird Ed has his package, Var[76] how a kid died
//         (1 steam, 2 the pool, 3 Ed and his hamster, 4 Green Tentacle, 6 the plant), Var[78] kids dead,
//         Var[82] the meteor's memoir (1 accepted, 4 published), Var[96] Dave is dead, Var[137] Green
//         Tentacle's recording contract.
//   $714B the 16 running-script slots, a global script's number each: 56 a kid dies, 57 the game is
//         lost, 58 the game is won.
//   $4A1F and $3BFF engine code that only Maniac Mansion has: Zak McKracken and the cartridge's menu
//         count for nothing.
//   Var[20] goes from 0 to 1 as a new game begins after the kids are picked, and back to 0 on a restart.
//   Rooms: 2 the drained pool, 4 the dungeon, 10 the hall, 28 the observatory, 30 the secret lab,
//   44 the road the game starts on, 51 the meteor's room.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/maniac-mansion.json'), 'utf8')), 'maniac-mansion.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '314bb3f8db2d69015131fe0fe8f4f243';
const VARS = 0xff67, SLOTS = 0x714b;
const ROOM = { pool: 2, dungeon: 4, hall: 10, observatory: 28, lab: 30, road: 44, meteor: 51, yard: 1 };
const GAME_OVER_ID = 0x7fffffff;

const unlocked = new Set();
const boards = [];
let over = 0;
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; over = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  codes.push(rc.activateAchievement(GAME_OVER_ID, set.gameOver));
  for (const l of set.leaderboards) codes.push(rc.activateLeaderboard(l.id, l.definition));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
    if (e.type !== EVENT.ACHIEVEMENT_TRIGGERED) continue;
    if (e.id === GAME_OVER_ID) over++;
    else unlocked.add(e.id);
  }
}
const starts = () => boards.filter((e) => e.type === EVENT.LBOARD_STARTED);
const submits = () => boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
const cancels = () => boards.filter((e) => e.type === EVENT.LBOARD_CANCELED);
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}

const v = (n, val) => { ram[VARS + n] = val; };
const get = (n) => ram[VARS + n];
const engine = (on = true) => {
  ram.set(on ? [0x30, 0x02, 0xa9, 0x00] : [0, 0, 0, 0], 0x4a1f);
  ram.set(on ? [0xbd, 0x53, 0xfe, 0x30] : [0, 0, 0, 0], 0x3bff);
};
/** Starts script `n` in the first free slot after slot 0, or stops it. */
function script(n, on = true) {
  for (let i = 1; i < 16; i++) {
    if (on && ram[SLOTS + i] === 0) { ram[SLOTS + i] = n; return; }
    if (!on && ram[SLOTS + i] === n) { ram[SLOTS + i] = 0; return; }
  }
}
/** The game under way on the road outside, as after the kids are picked. */
function begin() {
  activate(); frames(2);
  engine(); v(0, 3); v(20, 1); v(4, ROOM.road); ram[SLOTS] = 2; ram[SLOTS + 1] = 52;
  frames(2);
}
const go = (r) => { v(4, r); frames(2); };
/** A kid dies as script 56 does it: the cause first, then the count. */
function die(cause, kid = 4) {
  v(76, cause); script(56); frames(2);
  v(77, kid); v(78, get(78) + 1); if (kid === 3) v(96, 1); frames(2);
  script(56, false); frames(2);
}

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  expect(set.url === 'https://www.lemon64.com/game/maniac-mansion', 'the set links the game on Lemon64');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].lowerIsBetter === true, 'one board, faster is better');
  ok(`all ${set.achievements.length} achievements, the board and the game over parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('maniac-mansion-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'maniac-mansion-crt is not registered in test/external-assets.json';
    try { note = missingNote('maniac-mansion-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. Without Maniac Mansion's engine (Zak McKracken, the menu), nothing counts.
{
  activate(); frames(2);
  v(4, ROOM.road); frames(2);
  go(ROOM.hall); go(ROOM.lab);
  v(73, 1); frames(2);
  script(58); frames(2);
  expectNames('another game', []);
  expect(over === 0, 'no game over');
  ok('without the engine, nothing counts');
}

// 4. Rooms count when the game goes into them, not when they are already on screen.
{
  activate();
  engine(); v(4, ROOM.lab); frames(2);
  expectNames('already in the lab', []);
  go(ROOM.hall); go(ROOM.dungeon); go(ROOM.pool); go(ROOM.observatory); go(ROOM.lab); go(ROOM.meteor);
  expectNames('rooms', ['Face to Face', 'Inside the Lab', 'Stargazer', 'The Deep End', 'The Old Mansion', 'To the Dungeon!']);
  ok('rooms, entered');
}

// 5. Story flags count as they are set during play. A flag that comes with a change of room, as a
//    loaded game brings, counts for nothing.
{
  begin(); go(ROOM.hall);
  v(73, 1); frames(2);
  v(82, 1); frames(2);
  v(137, 1); frames(2);
  expectNames('flags', ['Special Delivery', 'Hot Stuff', 'GT and the Suction Cups', 'The Old Mansion']);
  begin();
  v(4, ROOM.hall); v(73, 1); v(82, 1); v(137, 1); frames(2);
  expectNames('flags with a room change', ['The Old Mansion']);
  ok('story flags');
}

// 6. Each cause of death, and losing all three kids.
{
  begin();
  die(1); die(2); die(3);
  expectNames('three deaths', ['Steamed', 'Glug! Glug!', 'Bits of Fur', 'Zombiehood']);
  begin();
  die(4); die(6);
  expectNames('two deaths', ['Band Members', 'Feed Me']);
  ok('deaths');
}

// 7. The Meteor Police ending, all three kids alive.
{
  begin(); go(ROOM.lab);
  v(18, 3); frames(2);
  script(58); frames(2);
  expectNames('police', ['Crater-Head', 'Inside the Lab', 'Nobody Left Behind', 'Sandy Rescued']);
  expect(over === 1, 'the game is over');
  ok('the Meteor Police ending');
}

// 8. The Edsel ending, after Dave died.
{
  begin();
  die(2, 3);
  v(18, 2); v(136, 1); frames(2);
  script(58); frames(2);
  expectNames('edsel', ['Glug! Glug!', 'Wheeeee!', 'Sandy Rescued', 'But That Is Another Story']);
  ok('the Edsel ending, Dave dead');
}

// 9. The publishing ending, another kid dead.
{
  begin();
  v(82, 1); frames(2);
  die(6, 5);
  v(82, 4); frames(2);
  script(58); frames(2);
  expectNames('memoir', ['Hot Stuff', 'Feed Me', 'Famous, Not Infamous', 'Sandy Rescued']);
  ok('the publishing ending');
}

// 10. Losing: a meltdown with kids left, and the game over after the third death.
{
  begin();
  script(57); frames(2);
  expectNames('meltdown', ['Five Mile Radius']);
  expect(over === 1, 'the meltdown ends the game');
  begin();
  die(1); die(2); die(6);
  script(57); frames(2);
  expectNames('all dead', ['Steamed', 'Glug! Glug!', 'Feed Me', 'Zombiehood']);
  expect(over === 1, 'the third death ends the game');
  ok('losing');
}

// 11. A set that comes in on the ending screen waits for the next ending.
{
  activate();
  engine(); v(4, 0); v(18, 3); script(58); frames(3);
  expectNames('ending already on screen', []);
  expect(over === 0, 'no game over');
  ok('an ending already on screen counts for nothing');
}

// 12. The speedrun: from a new game to the winning script. A restart or a lost game cancels it, and a
//     game that begins with story already done, as a loaded game, starts nothing.
{
  activate(); frames(2);
  engine(); v(4, 45); frames(2);
  v(20, 1); frames(2);
  expect(starts().length === 1, 'a new game starts the board');
  v(4, ROOM.hall); frames(100);
  v(18, 3); script(58); frames(2);
  const posted = submits();
  expect(posted.length === 1 && posted[0].value >= 100, `the win posts the time (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);

  activate(); frames(2);
  engine(); v(20, 1); frames(2);
  v(20, 0); frames(2);
  expect(starts().length === 1 && cancels().length === 1, 'a restart cancels it');
  v(20, 1); frames(2);
  script(57); frames(2);
  expect(starts().length === 2 && cancels().length === 2, 'a lost game cancels it');

  activate(); frames(2);
  engine(); v(82, 1); frames(2);
  v(20, 1); frames(2);
  expect(starts().length === 0, 'a game with story done starts nothing');
  ok('the speedrun');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Maniac Mansion set: ${testNo} spec checks`);
