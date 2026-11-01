// Spec tests for the Impossible Mission achievement set (server/sets/impossible-mission.json,
// Epyx 1984, on the OneLoad64 v5 cartridge). The clock is BCD: $D4 hours, $D3 minutes,
// $D2 seconds. It starts at 12:00 ($D4 = $12) and stops at 6:00. $D6 counts puzzle pieces,
// $D7 snooze and lift-reset codes, and $D8 solved puzzles. Each has one increment.
// The nine password letters at $345D start as $53. Searching the door, object $FE,
// increments $DC when every letter has changed. The score is BCD at $D9 (ones),
// $DA (hundreds) and $DB (ten-thousands), and it is written only when the game ends.
// $83A9 and $83B2 are the clock routine's two CMP opcodes, present once the game
// has unpacked and absent on the title.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/impossible-mission.json'), 'utf8')), 'impossible-mission.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = 'bf923fe8d24a1c9ef874484c62e857af';
const HOUR = 0xd4, PAUSE = 0xd5, PIECES = 0xd6, CODES = 0xd7, SOLVED = 0xd8;
const ONES = 0xd9, HUNDREDS = 0xda, TENK = 0xdb, DOOR = 0xdc, MODE = 0x43;
const CODE_A = 0x83a9, CODE_B = 0x83b2;

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

/** The elevator at 12:00, before anything has been found. The score bytes are still 0. */
function begin() {
  fresh();
  ram[HOUR] = 0x12;
  ram[PAUSE] = 0;
  ram[PIECES] = ram[CODES] = ram[SOLVED] = 0;
  ram[MODE] = 0;
  ram[ONES] = ram[HUNDREDS] = ram[TENK] = 0;
  ram[DOOR] = 0;
  ram[CODE_A] = 0xc9;
  ram[CODE_B] = 0xc9;
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge and its one score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE', 'one score board');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 135, 'the achievements add up to 135 points');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('impossible-mission-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'impossible-mission-crt is not registered in test/external-assets.json';
    try { note = missingNote('impossible-mission-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The title, and a title image with winning counters written over it: nothing, and no score.
{
  fresh();
  ram[HOUR] = 0;
  ram[PAUSE] = 0x27;
  ram[ONES] = ram[HUNDREDS] = ram[TENK] = 0x84;
  ram[DOOR] = 0x84;
  ram[CODE_A] = 0;
  ram[CODE_B] = 0xff;
  ram[PIECES] = 10;
  ram[CODES] = 1;
  ram[SOLVED] = 9;
  ram[HOUR] = 1;
  frames(5);
  expect(names().length === 0, `the title unlocks nothing (got ${names().join(', ')})`);
  expect(starts().length === 0 && submits().length === 0, 'the title posts no score');
  ok('the title unlocks nothing and posts no score');
}

// 4. Winning counters before the game has unpacked still count for nothing.
{
  fresh();
  ram[HOUR] = 0x12;
  ram[PIECES] = 10;
  ram[SOLVED] = 9;
  ram[DOOR] = 1;
  ram[CODE_A] = 0;
  ram[CODE_B] = 0;
  frames(4);
  expect(names().length === 0, `unpacked-code anchor held (got ${names().join(', ')})`);
  expect(starts().length === 0, 'the board stays shut');
  ok('counters before the game unpacks do not count');
}

// 5. An elevator at 12:00 with nothing found opens the board once and unlocks nothing.
{
  begin();
  frames(30);
  expect(names().length === 0, `a fresh game unlocks nothing (got ${names().join(', ')})`);
  expect(starts().length === 1, `the board opens once (got ${starts().length})`);
  expect(submits().length === 0, 'a score of zero is not posted');
  ok('the game opening posts nothing and starts the board once');
}

// 6. The first piece, then the tenth. Jumping straight to 10 counts only the tenth.
{
  begin();
  ram[PIECES] = 1;
  frames(2);
  expectNames('first piece', ['Puzzle Piece']);
  ram[PIECES] = 9;
  frames(2);
  expectNames('nine pieces', ['Puzzle Piece']);
  ram[PIECES] = 10;
  frames(2);
  expectNames('tenth piece', ['Puzzle Piece', 'Ten Pieces']);

  begin();
  ram[PIECES] = 10;
  frames(2);
  expectNames('pieces jump to 10', ['Ten Pieces']);
  ok('puzzle pieces count from the first and from the tenth');
}

// 7. A snooze or a lift reset is its own counter.
{
  begin();
  ram[CODES] = 1;
  frames(2);
  expectNames('one code', ['Snooze or Lift']);
  ram[PIECES] = 1;
  frames(2);
  expectNames('a piece does not replace the code', ['Snooze or Lift', 'Puzzle Piece']);
  ok('a snooze or a lift reset counts on its own');
}

// 8. Puzzles: the first, the third, and all nine. Eight is not the password.
{
  begin();
  ram[SOLVED] = 1;
  frames(2);
  expectNames('first puzzle', ['Puzzle Solved']);
  ram[SOLVED] = 2;
  frames(2);
  expectNames('second puzzle', ['Puzzle Solved']);
  ram[SOLVED] = 3;
  frames(2);
  expectNames('third puzzle', ['Puzzle Solved', 'Three Puzzles']);
  ram[SOLVED] = 8;
  frames(2);
  expectNames('eight puzzles', ['Puzzle Solved', 'Three Puzzles']);
  ram[SOLVED] = 9;
  frames(2);
  expectNames('nine puzzles', ['Puzzle Solved', 'Three Puzzles', 'The Password']);

  begin();
  ram[SOLVED] = 8;
  frames(2);
  expectNames('jump to eight', ['Three Puzzles']);
  ok('solved puzzles count at one, at three and at all nine');
}

// 9. The control-room door is $DC leaving 0, not the puzzle count.
{
  begin();
  ram[SOLVED] = 9;
  frames(2);
  expect(!names().includes('Control Room'), 'nine puzzles are not the door');
  ram[DOOR] = 1;
  frames(2);
  expect(names().includes('Control Room'), 'the door opens when $DC becomes 1');

  begin();
  ram[DOOR] = 1;
  frames(2);
  expectNames('door alone', ['Control Room']);
  ok('the control room opens when the door flag increments');
}

// 10. The clock awards one, three and five. Other hours, and a jump across them, do not.
{
  begin();
  ram[HOUR] = 0x01;
  frames(2);
  expectNames('one', ["One O'Clock"]);

  begin();
  ram[HOUR] = 0x02;
  frames(2);
  ram[HOUR] = 0x03;
  frames(2);
  expectNames('three', ["Three O'Clock"]);

  begin();
  ram[HOUR] = 0x04;
  frames(2);
  ram[HOUR] = 0x05;
  frames(2);
  expectNames('five', ["Five O'Clock"]);

  begin();
  ram[HOUR] = 0x01;
  frames(2);
  ram[HOUR] = 0x02;
  frames(2);
  expectNames('two o\'clock', ["One O'Clock"]);

  begin();
  ram[HOUR] = 0x05;
  frames(2);
  expectNames('jump from noon to five', []);
  ok('the clock counts one, three and five, and no hour in between');
}

// 11. A state that is already true on the first look waits until it has been false.
{
  activate();
  ram[HOUR] = 0x12;
  ram[CODE_A] = 0xc9;
  ram[CODE_B] = 0xc9;
  ram[PIECES] = 10;
  ram[SOLVED] = 9;
  ram[DOOR] = 1;
  frames(3);
  expect(names().length === 0, `the first look unlocks nothing (got ${names().join(', ')})`);
  ram[DOOR] = 0;
  ram[PIECES] = 0;
  ram[SOLVED] = 0;
  frames(2);
  ram[DOOR] = 1;
  frames(2);
  expectNames('door after it was false', ['Control Room']);
  ok('a condition already true on the first look waits until it has been false');
}

// 12. The board posts the ending score, as BCD, and a zero score stays off it.
{
  begin();
  ram[HUNDREDS] = 0x07;
  frames(2);
  expect(submits().length === 1 && submits()[0].value === 700, `700 posts as ${submits().map((e) => e.value).join(',')}`);

  begin();
  ram[HUNDREDS] = 0x46;
  frames(2);
  expect(submits().length === 1 && submits()[0].value === 4600, `4600 posts as ${submits().map((e) => e.value).join(',')}`);

  begin();
  ram[TENK] = 0x02;
  ram[HUNDREDS] = 0x26;
  ram[ONES] = 0x59;
  frames(2);
  expect(submits().length === 1 && submits()[0].value === 22659, `22659 posts as ${submits().map((e) => e.value).join(',')}`);

  begin();
  frames(5);
  expect(submits().length === 0, 'zero is not a posted score');
  ok('the ending score is posted as BCD and a zero score is not');
}

if (failing) {
  console.log(`\n${failing} failed, ${testNo - failing} passed`);
  process.exit(1);
}
console.log(`\nall ${testNo} tests passed`);
