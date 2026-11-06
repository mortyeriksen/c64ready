// Spec tests for the Last Ninja 3 achievement set (server/sets/last-ninja-3.json, System 3 1991, the
// EasyFlash cartridge in the OneLoad64 extras) under rcheevos, on synthesized RAM laid out as the game
// keeps it:
//   $0559 and $05A0 the engine's tables, in memory in every level and gone while a level loads.
//   $02-$05 the weapons held: sword, staff, nunchaku, shuriken. $1B Bushido (40 full). $1D lives.
//   $1F the level, 0-4. $0100-$0105 the score, six ASCII digits. $E3 the screen's enemy, $FC its state.
//   $0315 the message at a level's end: 3 when its guardian is beaten, 4 from the joystick level skip.
//   The Shogun, enemy 12, beaten on the fifth level wins the game. $03FF 1 with unlimited lives.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/last-ninja-3.json'), 'utf8')), 'last-ninja-3.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'e27836fc9c9a26d234f7695354e3ab8c';
const OVER = 0x7fffffff, NOTICE = 0x7ffffff0;

const unlocked = new Set(), notices = [];
const boards = [];
let over = 0;
function activate() {
  rc.clear(); unlocked.clear(); notices.length = 0; boards.length = 0; over = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  for (const l of set.leaderboards) codes.push(rc.activateLeaderboard(l.id, l.definition));
  codes.push(rc.activateAchievement(OVER, set.gameOver));
  for (const n of set.notices) codes.push(rc.activateAchievement(NOTICE + n.id, n.memaddr));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) {
      if (e.id === OVER) over++;
      else if (e.id > NOTICE) notices.push(set.notices.find((n) => n.id === e.id - NOTICE).title);
      else unlocked.add(e.id);
    } else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', '), exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const of = (t, id) => boards.filter((e) => e.type === t && (id === undefined || e.id === id));
const tables = (on) => { ram.set(on ? [0xe0, 0xe1, 0xe2, 0xe3] : [0, 0, 0, 0], 0x559); ram.set(on ? [0x31, 0x01, 0x6c, 0x01] : [0, 0, 0, 0], 0x5a0); };
const score = (n) => { ram.set([...Buffer.from(String(n).padStart(6, '0'))], 0x100); frames(2); };
/** The intro, then a new game: five lives, no score, Bushido 13, the first level loaded. */
function begin() {
  activate();
  ram.set([...Buffer.from('  \xde\xa9  ', 'latin1')], 0x100); frames(2);
  ram[0x1d] = 5; ram[0x1b] = 13; ram[0x1c] = 44; score(0);
  tables(true); frames(2);
}
/** A level's guardian beaten: message 3, the level counted on, then the next level loading. */
function levelDone() {
  ram[0x315] = 3; frames(2);
  ram[0x1f]++; frames(2);
  tables(false); ram[0x315] = 0; frames(2); tables(true); frames(2);
}
const shogun = () => { ram[0xe3] = 12; ram[0xfc] = 1; frames(2); score(+Buffer.from(ram.slice(0x100, 0x106)).toString() + 5000); tables(false); frames(2); };

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements, ${set.leaderboards.length} boards, the game over and ${set.notices.length} notices parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('last-ninja-3-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'last-ninja-3-crt is not registered in test/external-assets.json';
    try { note = missingNote('last-ninja-3-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. A whole game without a life lost: the weapons, a potion, Bushido, the five chambers and the
//    score; the ending posts the score and the time.
{
  begin();
  expect(of(EVENT.LBOARD_STARTED).length === 2, 'a new game starts both boards');
  score(1200);
  for (let w = 0; w < 4; w++) { ram[2 + w] = 1; frames(2); }
  ram[0x1d] = 6; frames(2);
  ram[0x1b] = 39; frames(2); ram[0x1b] = 40; frames(2);
  score(12000); levelDone(); score(26050); levelDone(); levelDone(); score(50100); levelDone();
  shogun();
  expectNames('the whole game', ['Earth', 'Fifty Thousand', 'First Blood', 'Fire', 'Iron Ninja', 'Nunchaku', 'Real Hatred Is Timeless', 'Second Wind', 'Ten Thousand',
    'The Staff', 'The Sword', 'Throwing Stars', 'Twenty-Five Thousand', 'Untouched Earth', 'Water', 'Way of the Warrior', 'Wind']);
  const hi = of(EVENT.LBOARD_TRIGGERED, 1), run = of(EVENT.LBOARD_TRIGGERED, 2);
  expect(hi.length === 1 && hi[0].value === 55100, `55,100 is posted (got ${hi.map((e) => e.value).join(',') || 'nothing'})`);
  expect(run.length === 1, 'the time is posted');
  expect(over === 1, 'the game is over');
  expect(notices.length === 0, 'no notice');
  ok('the whole game');
}

// 4. A life lost spoils the runs without one; the last life lost posts the score and cancels the time;
//    a game without points posts nothing.
{
  begin();
  score(800); ram[0x1d] = 4; frames(2); ram[0x1d] = 5; frames(2);
  levelDone();
  for (let l = 4; l >= 0; l--) { ram[0x1d] = l; frames(2); }
  expectNames('a life lost', ['Earth', 'First Blood', 'Second Wind']);
  const hi = of(EVENT.LBOARD_TRIGGERED, 1);
  expect(hi.length === 1 && hi[0].value === 800, `800 is posted (got ${hi.map((e) => e.value).join(',') || 'nothing'})`);
  expect(of(EVENT.LBOARD_TRIGGERED, 2).length === 0 && of(EVENT.LBOARD_CANCELED, 2).length === 1, 'the time is cancelled');
  expect(over === 1, 'the game is over');
  begin();
  for (let l = 4; l >= 0; l--) { ram[0x1d] = l; frames(2); }
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0 && of(EVENT.LBOARD_CANCELED).length === 2, 'no points: both boards are cancelled');
  ok('lives lost and game over');
}

// 5. The level skip: message 4 and its gifts count for nothing, and it is noticed; so is the trainer.
{
  begin();
  ram[0x315] = 4; ram.set([1, 1, 1], 2); ram[0x1b] = 40; score(1000); ram[0x1f] = 1; frames(2);
  expectNames('the level skip', ['First Blood', 'Nunchaku', 'The Staff', 'The Sword']);
  expect(notices.join() === 'Level skipped', `the level skip is noticed (got ${notices.join() || 'nothing'})`);
  begin();
  ram[0x3ff] = 1; frames(2);
  expect(notices.join() === 'Trainer on', `unlimited lives are noticed (got ${notices.join() || 'nothing'})`);
  ok('the level skip and the trainer');
}

// 6. Without the engine's tables nothing counts, and a level loading is no new game.
{
  activate(); frames(2);
  ram[0x1d] = 5; score(60000); ram.set([1, 1, 1, 1], 2); ram[0x315] = 3; ram[0x1f] = 1; ram[0xe3] = 12; ram[0xfc] = 1; ram[0x1f] = 4; frames(2);
  expectNames('no tables', []);
  begin(); levelDone();
  const starts = of(EVENT.LBOARD_STARTED).length;
  tables(false); frames(2); tables(true); frames(2);
  expect(starts === 2 && of(EVENT.LBOARD_STARTED).length === 2, 'the next level loading starts nothing');
  ok('nothing counts without the game');
}

// 7. Each score tier's score is what the board posts for a game ending right at the tier: a
//     post at or above it stays off the public wall until the tier is unlocked.
{
  const tiers = set.achievements.filter((a) => a.score !== undefined);
  expect(tiers.map((a) => a.title).join() === ['Ten Thousand', 'Twenty-Five Thousand', 'Fifty Thousand'].join(), `the score tiers (got ${tiers.map((a) => a.title).join()})`);
  for (const a of tiers) {
    begin(); score(a.score); for (let l = 4; l >= 0; l--) { ram[0x1d] = l; frames(2); }
    expect(unlocked.has(a.id), `${a.title} unlocks at ${a.score}`);
    const sub = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED).map((e) => e.value);
    expect(sub.at(-1) === a.score, `${a.title}: a game ending at the tier posts ${a.score} (got ${sub.join(',') || 'nothing'})`);
  }
  ok('score tiers match the board');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Last Ninja 3 set: ${testNo} spec checks`);
