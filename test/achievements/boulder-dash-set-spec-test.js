// Spec tests for the Boulder Dash achievement set (server/sets/boulder-dash.json,
// First Star 1984, on the OneLoad64 v5 cartridge).
// Play is a human game: $A2 is 0. The title, the F1 menu and the attract
// demo keep $A2 at 1. $73F5 is the first byte of the score routine, resident
// once the cartridge has unpacked. $A0 is 1 only when the last life is lost,
// and that same routine stores 3 back into $5C, so lives never stay at 0.
// $5C is lives. A new game starts at 3. $5D is the cave (1 is A, 5 is E,
// 9 is I, 13 is M). $5E is the difficulty byte (0 displays as 1, 4 as 5).
// $5F through $64 are the score, one digit each, from the 100000s to the ones.
// The screen shows each digit plus 16. $B0 and $B1 are the diamonds collected.
// $90 becomes 1 when the count meets the cave quota. $9F becomes 1 when Rockford
// enters the flashing exit. A death leaves both at 0.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/boulder-dash.json'), 'utf8')), 'boulder-dash.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'eac1087608ec1efef947e054d8968328';
const SCORE_OP = 0x73f5, DEMO = 0xa2, OVER = 0xa0, LIVES = 0x5c, CAVE = 0x5d, LEVEL = 0x5e;
const COMPLETE = 0x90, ENTERED = 0x9f, DIA10 = 0xb0, DIA1 = 0xb1, EXIT = 0x97;

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
  for (let i = 0; i < 6; i++) ram[0x5f + i] = s.charCodeAt(i) - 48;
}

/** Human play on cave A, difficulty 1, three lives, score still zero. */
function begin() {
  fresh();
  ram[SCORE_OP] = 0xa5;
  ram[DEMO] = 0;
  ram[OVER] = 0;
  ram[LIVES] = 3;
  ram[CAVE] = 1;
  ram[LEVEL] = 0;
  ram[COMPLETE] = 0;
  ram[ENTERED] = 0;
  ram[DIA10] = 0;
  ram[DIA1] = 0;
  score(0);
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge and its one score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.url === 'https://www.lemon64.com/game/boulder-dash', 'the set links the game on Lemon64');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE' && set.leaderboards[0].lowerIsBetter === false, 'one score board');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 200, 'the achievements add up to 200 points');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('boulder-dash-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'boulder-dash-crt is not registered in test/external-assets.json';
    try { note = missingNote('boulder-dash-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The title and the menu, however the bytes are dressed, unlock nothing.
{
  fresh();
  ram[SCORE_OP] = 0xa5;
  ram[DEMO] = 1;
  ram[OVER] = 0;
  ram[LIVES] = 4;
  ram[CAVE] = 13;
  ram[LEVEL] = 4;
  ram[COMPLETE] = 1;
  ram[ENTERED] = 1;
  ram[DIA10] = 9;
  ram[DIA1] = 9;
  ram[EXIT] = 2;
  score(50000);
  frames(4);
  expectNames('title', []);
  expect(starts().length === 0 && submits().length === 0, 'the title does not start or post a score');

  fresh();
  ram[SCORE_OP] = 0xa5;
  ram[DEMO] = 1;
  ram[OVER] = 0;
  ram[LIVES] = 0;
  ram[CAVE] = 1;
  ram[LEVEL] = 0;
  ram[COMPLETE] = 0;
  ram[ENTERED] = 0;
  score(0);
  frames(2);
  ram[CAVE] = 5;
  ram[LEVEL] = 4;
  frames(2);
  expectNames('menu', []);
  expect(starts().length === 0 && submits().length === 0, 'the menu does not start or post a score');
  ok('the title and the menu unlock nothing and post nothing');
}

// 4. The board starts when a human game begins with the score still zero.
//    The unpacked code has to be resident, and the three starting lives are
//    not an extra life. Nothing about cave A is an award.
{
  fresh();
  ram[SCORE_OP] = 0xa5;
  ram[DEMO] = 0;
  ram[OVER] = 0;
  ram[LIVES] = 0;
  ram[CAVE] = 0;
  score(0);
  frames(2);
  expect(starts().length === 0, 'boot, before the lives are dealt, does not start the board');
  ram[DEMO] = 1;
  ram[LIVES] = 0;
  ram[CAVE] = 1;
  frames(2);
  expectNames('still the title', []);
  expect(starts().length === 0, 'the title score of zero does not start the board');
  ram[DEMO] = 0;
  ram[LIVES] = 3;
  ram[LEVEL] = 0;
  ram[COMPLETE] = 0;
  ram[ENTERED] = 0;
  frames(2);
  expectNames('cave A', []);
  expect(starts().length === 1 && submits().length === 0, 'the board starts once, with nothing to post');
  ok('a fresh game starts the board and unlocks nothing');
}

// 5. Diamonds, the exit, and cave B. Cave A with the exit entered is not a later cave.
{
  begin();
  expectNames('no diamonds', []);
  ram[DIA1] = 1;
  frames(2);
  expectNames('one diamond', ['Shiny!']);
  ram[ENTERED] = 1;
  frames(2);
  expectNames('entered before the exit is open', ['Shiny!']);
  ram[ENTERED] = 0;
  frames(1);
  ram[COMPLETE] = 1;
  frames(2);
  expectNames('exit open', ['Shiny!', 'Quota Met']);
  ram[ENTERED] = 1;
  frames(2);
  expectNames('into the exit on cave A', ['Shiny!', 'Dig Out', 'Quota Met']);
  ram[CAVE] = 2;
  frames(2);
  expectNames('cave B', ['Shiny!', 'Cave B', 'Dig Out', 'Quota Met']);

  begin();
  ram[DIA10] = 1;
  ram[DIA1] = 2;
  frames(2);
  expectNames('a full quota of diamonds is not the open exit', ['Shiny!']);
  ram[EXIT] = 2;
  ram[LIVES] = 2;
  frames(2);
  expectNames('a failed cave', ['Shiny!']);
  expect(submits().length === 0, 'a failed cave posts nothing');

  begin();
  ram[CAVE] = 2;
  frames(2);
  expectNames('cave B before the exit is entered', []);
  ram[COMPLETE] = 1;
  ram[ENTERED] = 1;
  frames(2);
  expectNames('already on cave B when the exit is entered', ['Dig Out', 'Quota Met']);
  ok('a diamond, the open exit, and cave B');
}

// 6. Later caves are an edge under human play. Picking one on the menu, or
//    starting the game already there, does not count. Cave 1 does not either.
{
  fresh();
  ram[SCORE_OP] = 0xa5;
  ram[DEMO] = 1;
  ram[LIVES] = 0;
  ram[CAVE] = 5;
  ram[LEVEL] = 4;
  score(0);
  frames(2);
  ram[DEMO] = 0;
  ram[LIVES] = 3;
  frames(2);
  expectNames('started on cave E at difficulty 5', []);
  expect(starts().length === 1, 'that game still starts the board');

  begin();
  expectNames('cave A', []);
  ram[CAVE] = 4;
  frames(2);
  expectNames('cave D', []);
  ram[CAVE] = 5;
  frames(2);
  expectNames('cave E', ['Cave E']);
  ram[CAVE] = 8;
  frames(2);
  expectNames('cave H', ['Cave E']);
  ram[CAVE] = 9;
  frames(2);
  expectNames('cave I', ['Cave E', 'Cave I']);
  ram[CAVE] = 12;
  frames(2);
  expectNames('cave L', ['Cave E', 'Cave I']);
  ram[CAVE] = 13;
  frames(2);
  expectNames('cave M', ['Cave E', 'Cave I', 'Cave M']);

  begin();
  ram[LEVEL] = 4;
  frames(2);
  expectNames('jump to difficulty 5', []);
  begin();
  ram[LEVEL] = 3;
  frames(2);
  expectNames('difficulty 4', []);
  ram[LEVEL] = 4;
  frames(2);
  expectNames('difficulty 5', ['Hard Rock']);
  ok('caves E, I and M, and difficulty 5');
}

// 7. An extra life is a gain while the game is still going. The three lives
//    dealt at the start do not count, and neither does the restore on game over.
{
  begin();
  expectNames('three lives to start', []);
  ram[LIVES] = 2;
  frames(2);
  expectNames('one life lost', []);
  ram[LIVES] = 4;
  frames(2);
  expectNames('lives raised', ['One More Go']);

  begin();
  ram[LIVES] = 1;
  frames(1);
  ram[OVER] = 1;
  ram[LIVES] = 3;
  frames(2);
  expectNames('lives restored at game over', []);
  expect(submits().length === 0, 'a zero score at game over posts nothing');
  ok('an extra life, not the lives a game starts with');
}

// 8. Score thresholds. 999 is short of 1,000. 9,999 is short of 10,000.
//    A jump to 10,000 counts as both.
{
  begin();
  score(10);
  frames(2);
  expectNames('10', []);
  score(999);
  frames(2);
  expectNames('999', []);
  score(1000);
  frames(2);
  expectNames('1000', ['Rockford\'s Grand']);
  score(9999);
  frames(2);
  expectNames('9999', ['Rockford\'s Grand']);
  score(10000);
  frames(2);
  expectNames('10000', ['Rockford\'s Grand', 'Rolling in It']);

  begin();
  score(10000);
  frames(2);
  expectNames('jump to 10000', ['Rockford\'s Grand', 'Rolling in It']);
  ram[OVER] = 1;
  score(50000);
  frames(2);
  expectNames('a higher score once the game is over', ['Rockford\'s Grand', 'Rolling in It']);
  ok('1,000 and 10,000 points');
}

// 9. The board posts the displayed score when the game ends.
{
  begin();
  score(10);
  frames(2);
  ram[OVER] = 1;
  frames(2);
  let posted = submits();
  expect(posted.length === 1 && posted[0].value === 10, `a score of 10 posts 10 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);
  frames(2);
  expect(submits().length === 1, 'the same game over does not post again');

  begin();
  score(2500);
  frames(2);
  ram[LIVES] = 1;
  frames(1);
  ram[OVER] = 1;
  ram[LIVES] = 3;
  frames(2);
  posted = submits();
  expect(posted.length === 1 && posted[0].value === 2500, `a score of 2500 posts 2500 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);

  begin();
  score(654321);
  frames(2);
  ram[OVER] = 1;
  frames(2);
  posted = submits();
  expect(posted.length === 1 && posted[0].value === 654321, `a score of 654321 posts 654321 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);

  begin();
  score(0);
  ram[LIVES] = 1;
  frames(1);
  ram[OVER] = 1;
  ram[LIVES] = 3;
  frames(2);
  expect(submits().length === 0, 'a score of 0 posts nothing');

  begin();
  score(8000);
  ram[LIVES] = 2;
  frames(2);
  expect(submits().length === 0, 'losing one life posts nothing');
  ok('the score posts when the game ends');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - boulder dash set: ${testNo} spec checks`);
