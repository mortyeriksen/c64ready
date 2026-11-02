// Spec tests for the Paradroid achievement set (server/sets/paradroid.json,
// Hewson 1985, on the OneLoad64 v5 cartridge).
// A new game copies itself into RAM and plays with the bank register at 0.
// $67 is the ship, 0 on the logo and the briefing, then 1 for the whole game.
// $25 is 0 on the logo and on a deck, and 1 on the briefing, the game-on card
// and the deck selector. $6B is the transfer slot, 0 except during a transfer.
// $0340 is the droid you control. 0 is the 001. 3 is a 247 servant, 6 is a
// 302 messenger, 8 is a 420 maintenance droid, 11 is a 516 crew droid.
// $0360 is that droid's energy. A deck starts it at 64. Destroying the 001
// leaves it at 0. Losing a host restores energy before the frame ends.
// $59 is the number of droids still on the deck, you included. A clear is the
// frame it falls to 1. $33 is the deck. A new game rolls 4, 5, 6 or 7.
// The score is eight BCD digits at $21 (millions) through $24 (ones). The
// panel prints each nibble, with a leading zero as a blank. High nibble is
// 0xU and low nibble is 0xL. 0xH is the whole byte.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/paradroid.json'), 'utf8')), 'paradroid.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '6f183b6e268ae5c69d5ded042bb00fd9';
const SHIP = 0x67, MODE = 0x25, XFER = 0x6b, DECK = 0x33, COUNT = 0x59;
const TYPE = 0x340, ENERGY = 0x360;
const SCORE = [0x21, 0x22, 0x23, 0x24];

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

function bcd(n) {
  const s = String(n).padStart(8, '0');
  for (let i = 0; i < 4; i++) ram[SCORE[i]] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
}
function play() {
  ram[SHIP] = 1;
  ram[MODE] = 0;
  ram[XFER] = 0;
}

/** On a starting deck, still the 001, score still zero, several droids left. */
function begin() {
  fresh();
  play();
  ram[TYPE] = 0;
  ram[ENERGY] = 0x40;
  ram[COUNT] = 10;
  ram[DECK] = 5;
  bcd(0);
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge and its one score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.id === 'paradroid' && set.title === 'Paradroid', 'the set is Paradroid');
  expect(set.hashes.length === 1 && set.hashes[0].hash === HASH, 'the set names the OneLoad64 cartridge');
  expect(set.hashes[0].label === 'OneLoad64 v5 cartridge (Paradroid.crt)', 'the cartridge label');
  expect(set.url === 'https://www.lemon64.com/game/paradroid', 'the set links the game on Lemon64');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].id === 1 && set.leaderboards[0].format === 'SCORE' && set.leaderboards[0].lowerIsBetter === false, 'one score board');
  expect(/STA:.*::CAN:.*::SUB:.*::VAL:/.test(set.leaderboards[0].definition), 'the board has start, cancel, submit and value');
  expect(set.achievements.map((a) => a.id).join(',') === '1,2,3,4,5,6,7,8,9,10,11', 'achievement ids are 1 through 11');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 185, 'the achievements add up to 185 points');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('paradroid-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'paradroid-crt is not registered in test/external-assets.json';
    try { note = missingNote('paradroid-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The logo, the briefing, the game-on card and a transfer do not count.
{
  fresh();
  ram[DECK] = 0;
  ram[COUNT] = 0;
  ram[TYPE] = 0;
  ram[ENERGY] = 0;
  bcd(0);
  frames(4);
  expectNames('logo', []);
  expect(starts().length === 0 && submits().length === 0, 'the logo does not start or post a score');

  fresh();
  ram[MODE] = 1;
  ram[SHIP] = 0;
  ram[DECK] = 8;
  ram[TYPE] = 11;
  ram[COUNT] = 1;
  bcd(25001);
  frames(4);
  expectNames('briefing dressed as a win', []);
  expect(starts().length === 0, 'the briefing does not start the board');

  fresh();
  ram[SHIP] = 1;
  ram[MODE] = 1;
  ram[XFER] = 0;
  ram[DECK] = 8;
  ram[TYPE] = 0;
  ram[ENERGY] = 7;
  ram[COUNT] = 2;
  bcd(0);
  frames(2);
  ram[COUNT] = 1;
  frames(2);
  expectNames('game on', []);
  expect(starts().length === 0, 'the game-on card does not start the board');

  fresh();
  play();
  ram[XFER] = 1;
  ram[DECK] = 8;
  ram[TYPE] = 5;
  ram[ENERGY] = 0x40;
  ram[COUNT] = 1;
  bcd(500);
  frames(4);
  expectNames('transfer', []);
  expect(starts().length === 0 && submits().length === 0, 'a transfer does not start or post a score');
  ok('the title, the briefing, the game-on card and a transfer unlock nothing');
}

// 4. A condition that is already true on the first frame does not fire.
//    It fires once it has been false and then becomes true.
{
  activate();
  play();
  ram[TYPE] = 5;
  ram[DECK] = 8;
  ram[ENERGY] = 0x40;
  ram[COUNT] = 10;
  bcd(0);
  frame();
  expectNames('true before it has been false', []);
  expect(starts().length === 0, 'the board does not start on a first frame that is already true');
  ram[TYPE] = 0;
  ram[DECK] = 5;
  bcd(1);
  frame();
  expectNames('score after a zero frame', ['Boot Sequence']);
  expect(starts().length === 0, 'the board stays quiet while the score is not zero');
  bcd(0);
  ram[TYPE] = 5;
  ram[DECK] = 8;
  frame();
  expect(starts().length === 1 && submits().length === 0, 'the board starts once the score is zero again');
  expectNames('true again', ['Far Deck', 'Boot Sequence', 'Lift Off', 'Servant', 'Body Snatcher']);
  ok('a first frame that is already true does not unlock or start the board');
}

// 5. Entering a starting deck as the 001 starts the board and unlocks nothing.
{
  begin();
  expectNames('deck 5 as the 001', []);
  expect(starts().length === 1 && submits().length === 0, 'the board starts once, with nothing to post');
  for (const deck of [4, 6, 7]) {
    begin();
    ram[DECK] = deck;
    frames(2);
    expectNames(`start deck ${deck}`, []);
    expect(starts().length === 1, `deck ${deck} starts the board`);
  }
  ok('a fresh deck starts the board and unlocks nothing');
}

// 6. Score edges. 999 is not 1,000, and 9,999 is not 10,000.
{
  begin();
  bcd(1); frames(2);
  expectNames('1', ['Boot Sequence']);
  bcd(999); frames(2);
  expectNames('999', ['Boot Sequence']);
  bcd(1000); frames(2);
  expectNames('1000', ['Boot Sequence', 'One Thousand']);
  bcd(9999); frames(2);
  expectNames('9999', ['Boot Sequence', 'One Thousand']);
  bcd(10000); frames(2);
  expectNames('10000', ['Boot Sequence', 'One Thousand', 'Ten Thousand']);
  bcd(25001); frames(2);
  expectNames('25001', ['Boot Sequence', 'One Thousand', 'Ten Thousand']);
  bcd(1000042); frames(2);
  expectNames('1000042', ['Boot Sequence', 'One Thousand', 'Ten Thousand']);
  ok('score edges, including 999, 1,000, 9,999 and 10,000');
}

// 7. Droid classes. A 139 is not a servant. The 001 never is.
{
  begin();
  ram[TYPE] = 1; frames(2);
  expectNames('type 1', ['Body Snatcher']);
  ram[TYPE] = 2; frames(2);
  expectNames('type 2', ['Body Snatcher']);
  ram[TYPE] = 3; frames(2);
  expectNames('type 3', ['Servant', 'Body Snatcher']);
  ram[TYPE] = 5; frames(2);
  expectNames('type 5', ['Servant', 'Body Snatcher']);
  ram[TYPE] = 6; frames(2);
  expectNames('type 6', ['Messenger', 'Servant', 'Body Snatcher']);
  ram[TYPE] = 7; frames(2);
  expectNames('type 7', ['Messenger', 'Servant', 'Body Snatcher']);
  ram[TYPE] = 8; frames(2);
  expectNames('type 8', ['Maintenance', 'Messenger', 'Servant', 'Body Snatcher']);
  ram[TYPE] = 10; frames(2);
  expectNames('type 10', ['Maintenance', 'Messenger', 'Servant', 'Body Snatcher']);
  ram[TYPE] = 11; frames(2);
  expectNames('type 11', ['Crew', 'Maintenance', 'Messenger', 'Servant', 'Body Snatcher']);
  ram[TYPE] = 0; frames(2);
  expectNames('back to the 001', ['Crew', 'Maintenance', 'Messenger', 'Servant', 'Body Snatcher']);
  ok('a transfer, and each stronger class');
}

// 8. A deck is clear on the frame the count falls to 1. The game-on card
//    and a transfer both touch that count and neither counts.
{
  begin();
  ram[COUNT] = 2; frames(2);
  expectNames('two left', []);
  ram[COUNT] = 1; frames(2);
  expectNames('only you', ['Deck Clear']);
  begin();
  ram[COUNT] = 10; frames(1);
  ram[COUNT] = 1; frames(2);
  expectNames('straight to one', ['Deck Clear']);
  fresh();
  play();
  ram[COUNT] = 1;
  ram[DECK] = 5;
  ram[ENERGY] = 0x40;
  bcd(0);
  frames(3);
  expectNames('a deck that was already empty', []);
  fresh();
  ram[SHIP] = 1;
  ram[MODE] = 1;
  ram[COUNT] = 2;
  frames(1);
  ram[COUNT] = 1;
  frames(2);
  expectNames('game-on count', []);
  begin();
  ram[XFER] = 1;
  ram[COUNT] = 10; frames(1);
  ram[COUNT] = 1; frames(2);
  expectNames('count during a transfer', []);
  ok('clearing a deck');
}

// 9. Decks 4 through 7 are where a new game starts. A later index needs
//    the deck in play, not the selector and not the logo.
{
  begin();
  ram[DECK] = 3; frames(2);
  expectNames('deck 3', ['Lift Off']);
  ram[DECK] = 0; frames(2);
  expectNames('deck 0', ['Lift Off']);
  ram[DECK] = 7; frames(2);
  expectNames('back on a start deck', ['Lift Off']);
  begin();
  ram[DECK] = 8; frames(2);
  expectNames('deck 8', ['Far Deck', 'Lift Off']);
  ram[DECK] = 15; frames(2);
  expectNames('deck 15', ['Far Deck', 'Lift Off']);
  begin();
  ram[MODE] = 1;
  ram[DECK] = 8; frames(2);
  expectNames('deck 8 while selecting', []);
  begin();
  ram[XFER] = 1;
  ram[DECK] = 12; frames(2);
  expectNames('deck 12 during a transfer', []);
  fresh();
  ram[DECK] = 15;
  ram[SHIP] = 0;
  frames(2);
  expectNames('deck 15 on the logo', []);
  ok('a deck outside the starting four, and one further along');
}

// 10. The board posts the panel score when the 001's energy reaches 0.
//     Zero posts nothing. A host that fails, or a host that still has
//     energy, posts nothing. A transfer in progress does not block it.
{
  begin();
  bcd(25001);
  ram[ENERGY] = 0x40; frames(1);
  ram[ENERGY] = 0; frames(2);
  frames(3);
  let posted = submits();
  expect(posted.length === 1 && posted[0].value === 25001, `a 25,001 destruction posts 25001 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);

  begin();
  bcd(1000042);
  ram[ENERGY] = 0x40; frames(1);
  ram[ENERGY] = 0; frames(2);
  posted = submits();
  expect(posted.length === 1 && posted[0].value === 1000042, `a 1,000,042 destruction posts 1000042 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);

  begin();
  bcd(0);
  ram[ENERGY] = 0x40; frames(1);
  ram[ENERGY] = 0; frames(2);
  expect(submits().length === 0, 'a score of 0 posts nothing');

  begin();
  bcd(1000);
  ram[TYPE] = 5;
  ram[ENERGY] = 0x40; frames(1);
  ram[ENERGY] = 0; frames(2);
  expect(submits().length === 0, 'losing a host posts nothing');

  begin();
  bcd(1000);
  ram[TYPE] = 5;
  ram[ENERGY] = 0x40; frames(1);
  ram[TYPE] = 0;
  ram[ENERGY] = 7; frames(2);
  expect(submits().length === 0, 'a failed transfer that leaves the 001 with energy posts nothing');

  begin();
  bcd(500);
  ram[XFER] = 1;
  ram[ENERGY] = 0x40; frames(1);
  ram[ENERGY] = 0; frames(2);
  posted = submits();
  expect(posted.length === 1 && posted[0].value === 500, `a fatal transfer posts 500 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);
  ok('the score posts when the 001 is destroyed');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - paradroid set: ${testNo} spec checks`);
