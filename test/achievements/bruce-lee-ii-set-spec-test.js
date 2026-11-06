// Spec tests for the Bruce Lee II achievement set (server/sets/bruce-lee-ii.json, the 2015 C64 port,
// v1.9 on the EasyFlash cartridge in the OneLoad64 extras) under rcheevos, on synthesized RAM laid out
// as the game keeps it:
//   $3682 and $5D01 the game's code. $0419 the room (6 at the start, 35 the deep of the palace).
//   $041C the falls left, BCD. $06DC the state: 0 playing, 2 paused, 1 game over, 3 won.
//   $0620-$063F a bit for each room object, 241 set at the start, cleared as they are taken.
//   $3696 INFINITE LIVES (0 NO), $3697 the difficulty (0 ORIGINAL).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/bruce-lee-ii.json'), 'utf8')), 'bruce-lee-ii.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = set.hashes[0].hash;
const OVER = 0x7fffffff, NOTICE = 0x7ffffff0;

const unlocked = new Set(), notices = [], boards = [];
let over = 0;
function activate() {
  rc.clear(); unlocked.clear(); notices.length = 0; boards.length = 0; over = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  codes.push(rc.activateLeaderboard(1, set.leaderboards[0].definition));
  codes.push(rc.activateAchievement(OVER, set.gameOver));
  codes.push(rc.activateAchievement(NOTICE, set.notices[0].memaddr));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) { if (e.id === OVER) over++; else if (e.id === NOTICE) notices.push(e.id); else unlocked.add(e.id); }
    else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', '), exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const of = (t) => boards.filter((e) => e.type === t);
const code = () => { ram.set([0xad, 0x96, 0x36, 0xd0], 0x3682); ram.set([0xad, 0xdc, 0x06, 0xc9], 0x5d01); };
/** Objects taken: clears the first `n` set bits of the bitmap, as the game does one by one. */
function take(n) {
  for (let a = 0x620; a < 0x640 && n > 0; a++) for (let b = 7; b >= 0 && n > 0; b--) if (ram[a] & (1 << b)) { ram[a] &= ~(1 << b); n--; frames(1); }
  frames(1);
}
/** The title screen, then a new game: room 6, five falls, the objects in place. */
function begin({ easy = false } = {}) {
  activate();
  code(); ram[0x6dc] = 177; ram[0x419] = 41; ram[0x3697] = easy ? 1 : 0; frames(2);
  ram[0x6dc] = 0; ram[0x419] = 6; ram[0x41c] = easy ? 0x10 : 5;
  ram.fill(0xff, 0x620, 0x640); ram[0x63e] = 0x80; ram[0x63f] = 0;
  frames(2);
}
const bitsSet = () => { let n = 0; for (let a = 0x620; a < 0x640; a++) for (let v = ram[a]; v; v >>= 1) n += v & 1; return n; };
const room = (r) => { ram[0x419] = r; frames(2); };
const win = () => { ram[0x6dc] = 3; frames(2); };

// 1. Every condition parses, the set names the cartridge, and a new game holds 241 objects.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(/^[0-9a-f]{32}$/.test(HASH), 'the set names the cartridge');
  begin();
  expect(bitsSet() === 241, `the synthesized start holds 241 objects (got ${bitsSet()})`);
  ok(`all ${set.achievements.length} achievements, the board, the game over and the notice parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('bruce-lee-ii-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'bruce-lee-ii-crt is not registered in test/external-assets.json';
    try { note = missingNote('bruce-lee-ii-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. A game won without a fall lost on ORIGINAL: lanterns, an extra fall, the palace, Tao-Bao.
{
  begin();
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'a new game starts the speedrun');
  take(1); expectNames('one lantern', ['First Lantern']);
  take(48); expectNames('49 lanterns', ['First Lantern']);
  take(1); take(50);
  ram[0x41c] = 6; frames(2);
  ram[0x6dc] = 2; frames(2); ram[0x6dc] = 0; frames(2);
  room(29); room(35);
  win();
  expectNames('the whole game', ['A Hundred Lanterns', 'Extra Fall', 'Fifty Lanterns', 'First Lantern', 'Return of the Dragon', 'The Deep of His Palace', 'The Original Dragon', 'Untouchable']);
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'the pause starts nothing');
  expect(of(EVENT.LBOARD_TRIGGERED).length === 1, 'the time is posted');
  expect(over === 1, 'the game is over');
  ok('a game won');
}

// 4. A fall lost, and EASY: the win counts, the flawless and ORIGINAL wins do not.
{
  begin({ easy: true });
  ram[0x41c] = 0x09; frames(2);
  room(35); win();
  expectNames('easy, a fall lost', ['Return of the Dragon', 'The Deep of His Palace']);
  ok('a fall lost on EASY');
}

// 5. The last fall lost: the game over cancels the speedrun.
{
  begin();
  for (const f of [4, 3, 2, 1, 0]) { ram[0x41c] = f; frames(2); }
  ram[0x6dc] = 1; frames(2);
  expect(of(EVENT.LBOARD_CANCELED).length === 1 && of(EVENT.LBOARD_TRIGGERED).length === 0, 'the speedrun is cancelled');
  expect(over === 1, 'the game is over');
  ok('game over');
}

// 6. INFINITE LIVES is noticed; the title screen's junk counts for nothing.
{
  begin();
  expect(notices.length === 0, 'no notice without the trainer');
  ram[0x3696] = 1; frames(2);
  expect(notices.length === 1, 'INFINITE LIVES is noticed');
  activate();
  code(); ram[0x6dc] = 177; ram[0x419] = 41; frames(2);
  ram.fill(0, 0x620, 0x640); ram[0x419] = 35; ram[0x41c] = 0x20; frames(2);
  expectNames('the title screen', []);
  ok('the trainer and the title screen');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Bruce Lee II set: ${testNo} spec checks`);
