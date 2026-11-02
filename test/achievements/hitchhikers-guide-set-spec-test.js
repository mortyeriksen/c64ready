// Spec tests for The Hitchhiker's Guide to the Galaxy achievement set (server/sets/hitchhikers-guide.json,
// Infocom 1984, release 47 on disk) under rcheevos, on synthesized RAM laid out as the interpreter keeps
// the story (Z-machine version 3, its dynamic memory resident from $2A00):
//   $2A00 the header: version 3, release 47 at $2A02 (big-endian), serial "840914" at $2A12.
//   $48C8 the globals table (header word $0C + $2A00), big-endian words: global 0 the room's object,
//         global 1 the score, global 2 the moves. A new game or RESTART sets them to the Bedroom (168),
//         0 and 0.
// The score is out of 400. Arriving in the Vogon hold is worth 8, the babel fish 12, opening the glass
// case 25, and drinking the tea, which only happens past the screening door that wants tea and no tea,
// 100. Eating the sandwich, drinking the tea substitute or one wrong move with the spare drive each take
// 30 off, so the score can go below 0.
// Rooms: 25 Dark, 54 Dais, 76 Living Room (the party), 86 War Chamber, 99 Lair, 101 Airlock,
// 108 Captain's Quarters, 121 Vogon Hold, 134 Pub, 149 Front of House, 168 Bedroom, 174 Ramp (the end),
// 188 Engine Room, 190 Entry Bay Number Two, 191 Corridor, Aft End, 201 Bridge, 213 Inside the Sperm
// Whale, 218 Marvin's Pantry.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/hitchhikers-guide.json'), 'utf8')), 'hitchhikers-guide.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'a0c7dedd339ddca37ab122b0265e950d';
const STORY = 0x2a00, GLOBALS = 0x48c8;
const ROOM = { dark: 25, dais: 54, party: 76, war: 86, lair: 99, airlock: 101, quarters: 108, hold: 121, pub: 134, front: 149, bedroom: 168, ramp: 174, engine: 188, bay: 190, aft: 191, bridge: 201, whale: 213, pantry: 218 };

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
const scoreNow = () => { const v = getWord(GLOBALS + 2); return v >= 0x8000 ? v - 0x10000 : v; };
function header(release = 47) {
  ram[STORY] = 3; ram[STORY + 2] = release >> 8; ram[STORY + 3] = release & 255;
  [...'840914'].forEach((c, i) => { ram[STORY + 0x12 + i] = c.charCodeAt(0); });
}
/** The story loads into empty memory: in the dark bedroom, no score, no moves. */
function begin() { activate(); frames(2); header(); room(ROOM.bedroom); score(0); moves(0); frames(2); }
/** One move: into a room, scoring as given. */
function go(r, s = null) { room(r); if (s !== null) score(s); moves(getWord(GLOBALS + 4) + 1); frames(2); }
/** One move that scores some points, the room unchanged. */
const gain = (n) => go(getWord(GLOBALS), scoreNow() + n);

// 1. Every condition parses, and the set names the disk and its one board.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the release 47 disk');
  expect(set.url === 'https://www.lemon64.com/game/hitchhikers-guide-to-the-galaxy', 'the set links the game on Lemon64');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].lowerIsBetter === true, 'one board, fewer moves is better');
  ok(`all ${set.achievements.length} achievements and the board parse`);
}

// 2. The listed hash is the disk image's rcheevos hash.
{
  let file = null;
  try { file = assetPath('hitchhikers-guide-d64'); } catch { /* not registered */ }
  if (!file) {
    let note = 'hitchhikers-guide-d64 is not registered in test/external-assets.json';
    try { note = missingNote('hitchhikers-guide-d64'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the disk hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the disk hashes to the listed hash');
  }
}

// 3. Another story (or none) in memory counts for nothing, nor does a game that never started here.
{
  activate(); frames(2);
  header(59); room(ROOM.bedroom); score(0); moves(0); frames(2);
  go(ROOM.pub, 100);
  expectNames('another release', []);
  activate(); frames(2);
  header(); room(ROOM.pub); score(150); moves(80); frames(2);
  go(ROOM.hold, 158);
  expectNames('a game already under way', []);
  expect(starts().length === 0, 'and neither starts the board');
  ok('another release, or a game not started here, counts for nothing');
}

// 4. The opening, with the walkthrough's points: the analgesic, three beers in the pub, the dark, 8 for
//    the hold, then 12 for the babel fish.
{
  begin();
  expect(starts().length === 0, 'the board waits for the first move');
  go(ROOM.bedroom);
  expect(starts().length === 1, 'the first move starts the board');
  gain(10);
  expectNames('analgesic', ['Headache Gone']);
  go(ROOM.front); go(ROOM.pub); gain(5); gain(5); gain(5);
  go(ROOM.dark);
  go(ROOM.hold, scoreNow() + 8);
  expectNames('into the hold', ['Headache Gone', 'Hitching a Ride', 'You Are in the Dark', 'The Horse and Groom']);
  gain(12);
  expectNames('babel fish', ['Babel Fish', 'Headache Gone', 'Hitching a Ride', 'You Are in the Dark', 'The Horse and Groom']);
  ok('the opening, through the babel fish');
}

// 5. Only the babel fish's 12 points count as the fish: not the 8 for arriving, nor the 25 for the
//    glass case, nor 12 points elsewhere.
{
  begin();
  go(ROOM.bedroom, 10);
  go(ROOM.dark); go(ROOM.hold, 18);
  gain(25);
  expectNames('arriving and the case', ['Headache Gone', 'Hitching a Ride', 'You Are in the Dark']);
  go(ROOM.engine); gain(12);
  expectNames('12 points elsewhere', ['Engine Room', 'Headache Gone', 'Hitching a Ride', 'You Are in the Dark']);
  ok('the babel fish only for its own points in the hold');
}

// 6. The places further on, and the end on the ramp.
{
  begin();
  for (const r of [ROOM.quarters, ROOM.airlock, ROOM.bay, ROOM.bridge, ROOM.engine, ROOM.dais, ROOM.party, ROOM.lair, ROOM.war, ROOM.whale, ROOM.pantry, ROOM.ramp]) go(r);
  expectNames('places', ['Towel Required', 'So Long, and Thanks', 'Engine Room', 'Improbable Rescue', 'Marvin\'s Pantry', 'Oh No, Not Again', 'On the Bridge', 'Out of the Airlock', 'Party Time', 'President of the Galaxy', 'Vogon Poetry', 'War Chamber']);
  ok('the later places');
}

// 7. Tea and no tea: the 100 points for drinking the tea, which only the screening door allows.
//    Other points on the way there do not count.
{
  begin();
  go(ROOM.bridge, 250);
  go(ROOM.aft); gain(25);
  expect(!names().includes('Tea and No Tea'), '25 points is not the tea');
  gain(100);
  expect(names().includes('Tea and No Tea'), 'drinking the tea counts');
  ok('tea and no tea');
}

// 8. Score milestones. A 30-point mistake below 0 is not a high score, and climbing back past a
//    milestone from below 0 counts.
{
  begin();
  go(ROOM.pub, -20);
  expectNames('-20 points', ['The Horse and Groom']);
  go(ROOM.pub, 100);
  expectNames('100', ['Headache Gone', 'Hundred Points', 'The Horse and Groom']);
  go(ROOM.bridge, 400);
  expectNames('400', ['Headache Gone', 'Hundred Points', 'Mostly Harmless', 'On the Bridge', 'The Horse and Groom', 'Three Hundred', 'Two Hundred']);
  ok('score milestones, and a score below 0');
}

// 9. The board: moves to 400 points, from the first move. RESTART (moves back to 0) cancels it, and the
//    first move after it starts it again.
{
  begin();
  go(ROOM.bedroom);
  moves(120); score(200); frames(2);
  moves(0); score(0); room(ROOM.bedroom); frames(2);
  expect(cancels().length === 1 && starts().length === 1, 'RESTART cancels the board');
  go(ROOM.bedroom);
  expect(starts().length === 2, 'the first move after RESTART starts it again');
  moves(317); score(395); frames(2);
  moves(318); score(400); frames(2);
  const posted = submits();
  expect(posted.length === 1 && posted[0].value === 318, `400 points in 318 moves posts 318 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);
  ok('fewest moves to 400');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Hitchhiker's set: ${testNo} spec checks`);
