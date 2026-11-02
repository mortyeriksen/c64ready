// Spec tests for the Yie Ar Kung-Fu achievement set (server/sets/yie-ar-kung-fu.json,
// Imagine 1985, the OneLoad64 v5 cartridge).
//
// $A07E is the opponent index: $F3 on the history card, then 0 for Buchu.
// The on-screen stage is that index plus one, so 2 is Nuncha, 5 is Club and
// 8 is Tonfun. $A080 is the lives, 4 at the first bell and $FF on the menus.
// The score is three BCD bytes at $0380, low byte first. $0382 holds the
// 10,000s. The rank table's 009000 sits in the high-score bytes beside them.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/yie-ar-kung-fu.json'), 'utf8')), 'yie-ar-kung-fu.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'eab8e5d1e9791b6778372e29683d3a01';
const SCORE = 0x380, LEVEL = 0xa07e, LIVES = 0xa080;
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
function score(n) {
  const s = String(n).padStart(6, '0');
  ram[SCORE + 2] = (s.charCodeAt(0) - 48) << 4 | (s.charCodeAt(1) - 48);
  ram[SCORE + 1] = (s.charCodeAt(2) - 48) << 4 | (s.charCodeAt(3) - 48);
  ram[SCORE] = (s.charCodeAt(4) - 48) << 4 | (s.charCodeAt(5) - 48);
}
function fight() {
  ram[LEVEL] = 0;
  ram[LIVES] = 4;
  score(0);
}

{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.title === 'Yie Ar Kung-Fu', 'the set uses the game title');
  expect(set.url === 'https://www.lemon64.com/game/yie-ar-kung-fu', 'the set links the game on Lemon64');
  expect(set.hashes[0].hash === HASH, 'the set names the cartridge hash');
  expect(set.achievements.length === 12, 'twelve achievements');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 160, 'the achievements add up to 160 points');
  const l = set.leaderboards[0];
  expect(l.format === 'SCORE' && l.lowerIsBetter === false, 'the board is a score, higher is better');
  expect(/STA:.*::CAN:.*::SUB:.*::VAL:/.test(l.definition), 'the board has start, cancel, submit and value');
  expect(l.description === 'Your score when the last life is lost.', 'the board says when it posts');
  ok('all 12 achievements and the score parse');
}

{
  const key = 'yie-ar-kung-fu-crt';
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
  ram[LEVEL] = 0xaa;
  ram[LIVES] = 0x1c;
  frames(3);
  ram[LEVEL] = 0;
  ram[LIVES] = 0xff;
  ram[0x384] = 0x90;
  frames(3);
  ram[LEVEL] = 0xf3;
  ram[LIVES] = 4;
  score(1000);
  frames(3);
  expectNames('title, menu and history', []);
  expect(of(EVENT.LBOARD_STARTED).length === 0, 'the card does not start the board');
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'the canned high score posts nothing');
  ok('the title, the menus and the history card unlock nothing');
}

{
  activate();
  fight();
  score(1000);
  ram[LEVEL] = 1;
  frame();
  expectNames('true before it has been false', []);
  expect(of(EVENT.LBOARD_STARTED).length === 0, 'a board already true on the first frame does not start');
  ok('nothing unlocks before the fight state has been false');
}

{
  fresh();
  fight();
  frame();
  expectNames('the bell', []);
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'the fight starts the board at zero');
  score(400);
  frame();
  expectNames('400', ['Hiyah!']);
  score(500);
  frame();
  expectNames('500', ['Hiyah!', 'Five Hundred']);
  score(900);
  frame();
  expectNames('900', ['Hiyah!', 'Five Hundred']);
  score(1000);
  frame();
  expectNames('1000', ['Hiyah!', 'Five Hundred', 'One Thousand']);
  score(5000);
  frame();
  expectNames('5000', ['Hiyah!', 'Five Hundred', 'One Thousand', 'Five Thousand']);
  score(10000);
  frame();
  expectNames('10000', ['Hiyah!', 'Five Hundred', 'One Thousand', 'Five Thousand', 'Ten Thousand']);
  score(20000);
  frame();
  expectNames('20000', ['Hiyah!', 'Five Hundred', 'One Thousand', 'Five Thousand', 'Ten Thousand', 'Twenty Thousand']);
  score(50000);
  frame();
  expectNames('50000', ['Hiyah!', 'Five Hundred', 'One Thousand', 'Five Thousand', 'Ten Thousand', 'Twenty Thousand', 'Fifty Thousand']);
  ok('the score ladder follows the BCD bytes');
}

{
  fresh();
  fight();
  frame();
  ram[LEVEL] = 1;
  frame();
  expectNames('Buchu falls', ['Buchu Down']);
  ram[LEVEL] = 2;
  frame();
  expectNames('Nuncha', ['Buchu Down', 'Nuncha']);
  ram[LEVEL] = 5;
  frame();
  expectNames('Club', ['Buchu Down', 'Nuncha', 'Club']);
  ram[LEVEL] = 8;
  frame();
  expectNames('Tonfun', ['Buchu Down', 'Nuncha', 'Club', 'Tonfun']);
  ram[LIVES] = 5;
  frame();
  expectNames('fifth life', ['Buchu Down', 'Nuncha', 'Club', 'Tonfun', 'Fifth Life']);
  ok('later opponents and a fifth life count');
}

{
  fresh();
  fight();
  frame();
  ram[LIVES] = 1;
  frame();
  ram[LIVES] = 0;
  frame();
  expect(of(EVENT.LBOARD_CANCELED).length === 1, 'a scoreless loss cancels');
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'a scoreless loss posts nothing');
  ok('losing with no score cancels the board');
}

{
  fresh();
  fight();
  frame();
  score(11500);
  frame();
  ram[LIVES] = 1;
  frame();
  ram[LIVES] = 0;
  frame();
  const posted = of(EVENT.LBOARD_TRIGGERED);
  expect(posted.length === 1 && posted[0].value === 11500, `the last life posts 11500 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);
  expect(of(EVENT.LBOARD_CANCELED).length === 0, 'a scored loss is not cancelled');
  ok('the last life posts the BCD score once');
}

if (failing) {
  console.log(`\n${failing} failing`);
  process.exit(1);
}
console.log(`\n# tests ${testNo}`);
