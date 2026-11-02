// Spec tests for the Zork I achievement set (server/sets/zork-i.json, Infocom, release 30 on disk)
// under rcheevos, on synthesized RAM laid out as the interpreter keeps the story (Z-machine version 3,
// its dynamic memory resident from $2A00):
//   $2A00 the header: version 3, release 30 at $2A02 (big-endian), serial "830330" at $2A12.
//   $4C24 the globals table, big-endian words: global 0 the room's object, global 1 the score (out of
//         350, 10 less for each death, so it can go below 0), global 2 the moves. A new game or RESTART
//         sets them to West of House (223), 0 and 0.
//   $2CEC the first object, 9 bytes each, the parent at +4. The player is object 224. The egg is 71,
//         the bauble 69 (out of play, parent 0, until the canary is wound), the troll 205 (in the troll
//         room, 87), the cyclops 173 (in the cyclops room, 172). Either leaves play when it dies or flees:
//         its parent becomes 0. The thief (97) leaves play while he roams, so his parent says nothing.
//         The trophy case is 181.
//   Rooms: 14 On the Rainbow, 58 Cellar, 77 Up a Tree, 117 Dome Room, 123 Loud Room, 164 Stone Barrow,
//   174 Atlantis Room, 192 Kitchen, 208 Temple, 218 Land of the Dead, 223 West of House.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/zork-i.json'), 'utf8')), 'zork-i.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '066845adee747394e0395ddc613d4372';
const STORY = 0x2a00, GLOBALS = 0x4c24, OBJ = 0x2cec, PLAYER = 224;
const EGG = 71, BAUBLE = 69, TROLL = 205, CYCLOPS = 173, THIEF = 97, CASE = 181;
const ROOM = { rainbow: 14, cellar: 58, tree: 77, dome: 117, loud: 123, barrow: 164, atlantis: 174, kitchen: 192, temple: 208, dead: 218, west: 223, trollRoom: 87, cyclopsRoom: 172, roundRoom: 92 };

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
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const submits = () => boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
const starts = () => boards.filter((e) => e.type === EVENT.LBOARD_STARTED);
const cancels = () => boards.filter((e) => e.type === EVENT.LBOARD_CANCELED);

const setWord = (a, v) => { v &= 0xffff; ram[a] = v >> 8; ram[a + 1] = v & 255; };
const getWord = (a) => (ram[a] << 8) | ram[a + 1];
const room = (r) => setWord(GLOBALS, r);
const score = (s) => setWord(GLOBALS + 2, s);
const moves = (m) => setWord(GLOBALS + 4, m);
const parentOf = (n, p) => { ram[OBJ + 9 * (n - 1) + 4] = p; };
function header(release = 30) {
  ram[STORY] = 3; ram[STORY + 2] = release >> 8; ram[STORY + 3] = release & 255;
  [...'830330'].forEach((c, i) => { ram[STORY + 0x12 + i] = c.charCodeAt(0); });
}
/** The story loads into empty memory: West of House, no score, no moves, everything where it starts. */
function begin() {
  activate(); frames(2);
  header(); room(ROOM.west); score(0); moves(0);
  parentOf(EGG, 72); parentOf(BAUBLE, 0); parentOf(TROLL, ROOM.trollRoom); parentOf(CYCLOPS, ROOM.cyclopsRoom); parentOf(THIEF, ROOM.roundRoom);
  frames(2);
}
/** One move: into a room, the score as given. */
function go(r, s = null) { room(r); if (s !== null) score(s); moves(getWord(GLOBALS + 4) + 1); frames(2); }

// 1. Every condition parses, and the set names the disk and its one board.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the release 30 disk');
  expect(set.url === 'https://www.lemon64.com/game/zork-1-the-great-underground-empire', 'the set links the game on Lemon64');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].lowerIsBetter === true, 'one board, fewer moves is better');
  ok(`all ${set.achievements.length} achievements and the board parse`);
}

// 2. The listed hash is the disk image's rcheevos hash.
{
  let file = null;
  try { file = assetPath('zork-i-d64'); } catch { /* not registered */ }
  if (!file) {
    let note = 'zork-i-d64 is not registered in test/external-assets.json';
    try { note = missingNote('zork-i-d64'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the disk hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the disk hashes to the listed hash');
  }
}

// 3. Another release, or a game already under way when the set came in, counts for nothing.
{
  activate(); frames(2);
  header(88); room(ROOM.west); score(0); moves(0); frames(2);
  go(ROOM.kitchen, 10); go(ROOM.cellar, 35);
  expectNames('another release', []);
  activate(); frames(2);
  header(); room(ROOM.kitchen); score(60); moves(40); frames(2);
  go(ROOM.cellar, 85);
  expectNames('a game under way', []);
  expect(starts().length === 0, 'neither starts the board');
  ok('another release, or a game not started here, counts for nothing');
}

// 4. The opening: the tree and the egg, the kitchen, the cellar.
{
  begin();
  go(ROOM.tree);
  parentOf(EGG, PLAYER); go(ROOM.tree, 5);
  go(ROOM.kitchen, 15);
  go(ROOM.cellar, 40);
  expectNames('opening', ['Breaking and Entering', 'Down the Trap Door', 'Egg Hunt', 'Up a Tree', 'Welcome to Zork']);
  ok('the opening');
}

// 5. The bauble, the egg in the trophy case, and the troll and cyclops leaving play. The thief leaving
//    play as he roams counts for nothing.
{
  begin();
  parentOf(BAUBLE, 62); frames(2);
  expectNames('bauble', ['Songbird']);
  parentOf(THIEF, 101); frames(2);
  parentOf(THIEF, 0); frames(2);
  expectNames('thief roams', ['Songbird']);
  parentOf(EGG, CASE); frames(2);
  expectNames('egg in the case', ['Songbird', 'Trophy Case']);
  parentOf(TROLL, 0); frames(2);
  parentOf(CYCLOPS, 0); frames(2);
  expectNames('monsters', ['Songbird', 'Trophy Case', 'Troll Slayer', 'Ulysses']);
  ok('the bauble, the trophy case and the monsters');
}

// 6. The places further on, and the end in the stone barrow.
{
  begin();
  for (const r of [ROOM.loud, ROOM.dome, ROOM.temple, ROOM.atlantis, ROOM.rainbow, ROOM.dead, ROOM.barrow]) go(r);
  expectNames('places', ['Atlantis', 'Dome Room', 'Land of the Dead', 'Loud Room', 'Over the Rainbow', 'Temple', 'The Stone Barrow']);
  ok('the later places');
}

// 7. Score milestones. A death below 0 points is not a high score.
{
  begin();
  go(ROOM.west, -10);
  expectNames('-10 points', []);
  go(ROOM.kitchen, 100);
  expectNames('100', ['Breaking and Entering', 'Hundred Points', 'Welcome to Zork']);
  go(ROOM.kitchen, 350);
  expectNames('350', ['Breaking and Entering', 'Hundred Points', 'Master Adventurer', 'Three Hundred', 'Two Hundred', 'Welcome to Zork']);
  ok('score milestones, and a score below 0');
}

// 8. The board: moves to 350, from the first move. RESTART cancels it, and the next first move starts it.
{
  begin();
  go(ROOM.west);
  expect(starts().length === 1, 'the first move starts the board');
  moves(90); score(-10); frames(2);
  expect(submits().length === 0, 'a score below 0 posts nothing');
  moves(0); score(0); room(ROOM.west); frames(2);
  expect(cancels().length === 1, 'RESTART cancels it');
  go(ROOM.west);
  expect(starts().length === 2, 'the first move after RESTART starts it again');
  moves(411); score(340); frames(2);
  moves(412); score(350); frames(2);
  const posted = submits();
  expect(posted.length === 1 && posted[0].value === 412, `350 points in 412 moves posts 412 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);
  ok('fewest moves to 350');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Zork I set: ${testNo} spec checks`);
