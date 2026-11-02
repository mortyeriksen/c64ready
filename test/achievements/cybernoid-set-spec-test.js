// Spec tests for the Cybernoid achievement set (server/sets/cybernoid.json,
// Hewson 1988, the OneLoad64 v5 cartridge).
//
// $14 is the ships: 0 on the menu, 4 when a game starts, and the last one
// falling through 1 to 0 is the end. $588F-$5894 are the six score digits,
// each 0-9, highest first. The menu leaves 48 in the first of those. Cargo
// is a 16-bit count at $2E97/$2E98 and the depot takes 1500. $2E92 is the
// level, $3F4A the screen. The five weapon counts start at 20, 20, 1, 5 and
// 5. The clock's high byte is $3A1C, and 1 is the low band.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/cybernoid.json'), 'utf8')), 'cybernoid.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'a511a0b9beb9af0631e49019f509d866';
const LIVES = 0x14, SCORE = 0x588f, CARGO = 0x2e97, LEVEL = 0x2e92, ROOM = 0x3f4a, TIME = 0x3a1c;
const AMMO = [0x5b79, 0x5b89, 0x5b99, 0x5ba9, 0x5bb9];
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
  ram[LIVES] = 4;
  digits(0);
  ram[CARGO] = 0; ram[CARGO + 1] = 0;
  ram[LEVEL] = 0; ram[ROOM] = 0;
  ram[TIME] = 7;
  const start = [20, 20, 1, 5, 5];
  AMMO.forEach((a, i) => { ram[a] = start[i]; });
}

{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.title === 'Cybernoid', 'the set uses the game title');
  expect(set.url === 'https://www.lemon64.com/game/cybernoid', 'the set links the game on Lemon64');
  expect(set.hashes[0].hash === HASH, 'the set names the cartridge hash');
  expect(set.achievements.length === 13, 'thirteen achievements');
  expect(set.achievements.every((a, i) => a.id === i + 1), 'achievement IDs follow display order');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 165, 'the achievements add up to 165 points');
  const l = set.leaderboards[0];
  expect(l.format === 'SCORE' && l.lowerIsBetter === false, 'the board is a score, higher is better');
  expect(/STA:.*::CAN:.*::SUB:.*::VAL:/.test(l.definition), 'the board has start, cancel, submit and value');
  expect(l.description === 'Your score when the last ship is lost.', 'the board says when it posts');
  ok('all 13 achievements and the score parse');
}

{
  const key = 'cybernoid-crt';
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
  ram[LIVES] = 0;
  ram[SCORE] = 48;
  frames(3);
  expectNames('menu', []);
  expect(of(EVENT.LBOARD_STARTED).length === 0, 'the menu does not start the board');
  ok('the menu unlocks nothing and posts nothing');
}

{
  activate();
  play();
  digits(500);
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
  digits(500);
  frames(2);
  expectNames('500', ['Five Hundred']);
  digits(10000);
  frames(2);
  expectNames('10000', ['Five Hundred', 'Ten Thousand']);
  ram[CARGO] = 50;
  frames(2);
  expectNames('cargo', ['Five Hundred', 'Ten Thousand', 'Salvage']);
  ram[CARGO] = 220; ram[CARGO + 1] = 5;
  frames(2);
  expectNames('hold', ['Five Hundred', 'Ten Thousand', 'Salvage', 'Full Hold']);
  ram[ROOM] = 1;
  frames(2);
  expectNames('screen', ['Five Hundred', 'Ten Thousand', 'Salvage', 'Full Hold', 'Moving Out']);
  ram[LEVEL] = 1;
  frames(2);
  expectNames('l2', ['Five Hundred', 'Ten Thousand', 'Salvage', 'Full Hold', 'Moving Out', 'Level Two']);
  ram[LEVEL] = 2;
  frames(2);
  expectNames('l3', ['Five Hundred', 'Ten Thousand', 'Salvage', 'Full Hold', 'Moving Out', 'Level Two', 'Level Three']);
  for (const a of AMMO) ram[a]--;
  frames(2);
  expectNames('weapons', ['Five Hundred', 'Ten Thousand', 'Salvage', 'Full Hold', 'Moving Out', 'Level Two', 'Level Three', 'Bombs Away', 'Mind the Gap', 'Shields Up', 'Bouncy Castle', 'Heat Seeker']);
  ram[TIME] = 1;
  frames(2);
  expectNames('time', ['Five Hundred', 'Ten Thousand', 'Salvage', 'Full Hold', 'Moving Out', 'Level Two', 'Level Three', 'Bombs Away', 'Mind the Gap', 'Shields Up', 'Bouncy Castle', 'Heat Seeker', 'Cutting It Fine']);
  ok('the round follows the score, the hold, the screens and the weapons');
}

{
  fresh();
  play();
  frames(2);
  ram[CARGO + 1] = 4; ram[CARGO] = 255;
  frames(2);
  const fullHold = set.achievements.find((a) => a.title === 'Full Hold').id;
  expect(!unlocked.has(fullHold), '1499 cargo is not a full hold');
  ram[CARGO + 1] = 6; ram[CARGO] = 0;
  frames(2);
  expect(unlocked.has(fullHold), '1536 cargo is a full hold');
  ok('the hold opens at 1500 cargo');
}

{
  fresh();
  play();
  frames(2);
  digits(500);
  frames(2);
  ram[LIVES] = 1;
  frames(1);
  ram[LIVES] = 0;
  frames(2);
  const posts = of(EVENT.LBOARD_TRIGGERED);
  expect(posts.length === 1, 'the last ship posts one score');
  expect(posts[0]?.value === 500, `the posted score is 500, got ${posts[0]?.value}`);
  expect(of(EVENT.LBOARD_CANCELED).length === 0, 'a scored loss does not cancel');
  fresh();
  play();
  frames(2);
  ram[LIVES] = 1;
  frames(1);
  ram[LIVES] = 0;
  frames(2);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'a scoreless loss posts nothing');
  expect(of(EVENT.LBOARD_CANCELED).length === 1, 'a scoreless loss cancels');
  ok('the last ship posts the score, or cancels when it is still zero');
}

if (failing) {
  console.error(`\n${failing} test(s) failed`);
  process.exit(1);
}
console.log(`\nall ${testNo} tests passed`);
