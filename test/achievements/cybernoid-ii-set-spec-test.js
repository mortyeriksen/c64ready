// Spec tests for the Cybernoid II achievement set (server/sets/cybernoid-ii.json,
// Hewson 1988, the OneLoad64 v5 cartridge).
//
// $1F is 0 on the menu and 255 once the ship is flying. $14 is the ships:
// 0 on the menu, 4 at the start, and one more can be earned. $3021-$3026 are
// the six score digits, each 0-9, highest first. On the menu those bytes are
// the screen code 48, so the flying flag has to gate them. Cargo is the
// 16-bit value at $31/$32, low byte first. $33 counts the 20 segments of
// the level timer, with 19 leaving one segment remaining.
// $2D advances 0, 1, 2, 3 as the four levels begin, then wraps to 0.
// $59 is the screen index. Level One begins at 6, and screen changes may
// follow different routes through the map.
// The hall of fame brings $1F back to 0 with the ships already gone.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/cybernoid-ii.json'), 'utf8')), 'cybernoid-ii.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '2d8145ab07c4f45110a69428eab0e91a';
const FLY = 0x1f, LIVES = 0x14, SCORE = 0x3021, CARGO = 0x31, CLOCK = 0x33, LEVEL = 0x2d, SCREEN = 0x59;
const BOARD = 1;

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
const of = (type) => boards.filter((e) => e.id === BOARD && e.type === type);
function digits(n) {
  const s = String(n).padStart(6, '0');
  for (let i = 0; i < 6; i++) ram[SCORE + i] = s.charCodeAt(i) - 48;
}
function play() {
  ram[FLY] = 255;
  ram[LIVES] = 4;
  digits(0);
  ram[CARGO] = 0; ram[CARGO + 1] = 0;
  ram[CLOCK] = 0;
  ram[LEVEL] = 0;
  ram[SCREEN] = 6;
}

{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.title === 'Cybernoid II', 'the set uses the game title');
  expect(set.url === 'https://www.lemon64.com/game/cybernoid-2', 'the set links the game on Lemon64');
  expect(set.hashes[0].hash === HASH, 'the set names the cartridge hash');
  expect(set.achievements.length === 10, 'ten achievements');
  expect(set.achievements.every((a, i) => a.id === i + 1), 'achievement IDs follow display order');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 180, 'the achievements add up to 180 points');
  const l = set.leaderboards[0];
  expect(l.format === 'SCORE' && l.lowerIsBetter === false, 'the board is a score, higher is better');
  expect(/STA:.*::CAN:.*::SUB:.*::VAL:/.test(l.definition), 'the board has start, cancel, submit and value');
  expect(l.description === 'Your score when the last ship is lost.', 'the board says when it posts');
  ok('all 10 achievements and the score parse');
}

{
  const key = 'cybernoid-ii-crt';
  let file = null;
  try { file = assetPath(key); } catch { /* not registered yet */ }
  if (!file) {
    let note = `${key} is not registered in test/external-assets.json`;
    try { note = missingNote(key); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: ${key} hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok(`${key} hashes to the listed hash`);
  }
}

{
  fresh();
  ram[FLY] = 0;
  ram[LIVES] = 0;
  for (let i = 0; i < 6; i++) ram[SCORE + i] = 48;
  frames(3);
  expectNames('menu', []);
  expect(of(EVENT.LBOARD_STARTED).length === 0, 'the menu does not start the board');
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'the menu score posts nothing');
  ok('the menu unlocks nothing and posts nothing');
}

{
  activate();
  play();
  digits(10000);
  frame();
  expectNames('true before it has been false', []);
  expect(of(EVENT.LBOARD_STARTED).length === 0, 'the board does not start on a first frame');
  ok('a condition already true on the first frame does not fire');
}

{
  fresh();
  play();
  frames(2);
  expectNames('just started', []);
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'a new game starts the board');
  digits(25);
  frames(2);
  expectNames('25', []);
  digits(100);
  frames(2);
  expectNames('100', []);
  digits(1000);
  frames(2);
  expectNames('1000', ['One Thousand']);
  digits(10000);
  frames(2);
  expectNames('10000', ['One Thousand', 'Ten Thousand']);
  ram[CARGO] = 0x32;
  frames(2);
  expectNames('cargo 50', ['One Thousand', 'Ten Thousand', 'Finders Keepers']);
  ram[CARGO] = 100;
  frames(2);
  expectNames('cargo 100', ['One Thousand', 'Ten Thousand', 'Finders Keepers', 'Pirate\'s Ton']);
  ram[LIVES] = 5;
  frames(2);
  expectNames('ship', ['One Thousand', 'Ten Thousand', 'Finders Keepers', 'Pirate\'s Ton', 'Spare Ship']);
  ok('the round follows the score, the cargo and the extra ship');
}

{
  fresh();
  ram[CLOCK] = 19;
  frames(2);
  expectNames('menu timer data', []);
  play();
  frames(2);
  ram[CLOCK] = 1;
  frames(2);
  expectNames('first timer segment', []);
  ram[CLOCK] = 18;
  frames(2);
  expectNames('two timer segments left', []);
  ram[CLOCK] = 19;
  frames(2);
  expectNames('last timer segment', ['Cutting It Fine']);
  ok('low time means the final timer segment, not the first');
}

{
  fresh();
  ram[LEVEL] = 1;
  frames(2);
  expectNames('menu level data', []);
  ram[LEVEL] = 0;
  frame();
  play();
  frames(2);
  ram[LEVEL] = 1;
  frame();
  expectNames('second level', ['Level Two']);
  ram[LEVEL] = 2;
  frame();
  expectNames('third level', ['Level Two', 'Level Three']);
  ram[LEVEL] = 3;
  frame();
  expectNames('fourth level', ['Level Two', 'Level Three', 'The Final Level']);
  ram[LEVEL] = 0;
  frame();
  expectNames('level loop', ['Level Two', 'Level Three', 'The Final Level']);
  ok('all four levels advance in play, and menu data does not count');
}

{
  fresh();
  ram[SCREEN] = 8;
  frames(2);
  expectNames('menu screen data', []);
  play();
  frames(2);
  expectNames('first screen', []);
  ram[SCREEN] = 11;
  frames(2);
  expectNames('second screen', []);
  ram[SCREEN] = 16;
  frames(2);
  expectNames('third screen', ['Launch!']);
  ok('the mission launches on a second screen change along another route');
}

{
  fresh();
  play();
  frames(2);
  ram[SCREEN] = 7;
  frames(2);
  expectNames('one change', []);
  ram[FLY] = 0;
  ram[LIVES] = 0;
  frames(2);
  play();
  frames(2);
  ram[SCREEN] = 7;
  frames(2);
  expectNames('a new run has one change', []);
  ram[SCREEN] = 8;
  frames(2);
  expectNames('a new run has two changes', ['Launch!']);
  ok('screen progress resets between runs');
}

{
  fresh();
  play();
  frames(2);
  digits(10000);
  frames(2);
  ram[LIVES] = 0;
  ram[FLY] = 0;
  frames(2);
  const posts = of(EVENT.LBOARD_TRIGGERED);
  expect(posts.length === 1, 'the hall of fame posts one score');
  expect(posts[0]?.value === 10000, `the posted score is 10000, got ${posts[0]?.value}`);
  expect(of(EVENT.LBOARD_CANCELED).length === 0, 'a scored ending does not cancel');
  fresh();
  play();
  frames(2);
  ram[LIVES] = 0;
  ram[FLY] = 0;
  frames(2);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'a scoreless ending posts nothing');
  expect(of(EVENT.LBOARD_CANCELED).length === 1, 'a scoreless ending cancels');
  ok('the hall of fame posts the score, or cancels when it is still zero');
}

if (failing) {
  console.error(`\n${failing} test(s) failed`);
  process.exit(1);
}
console.log(`\nall ${testNo} tests passed`);
