// Spec tests for the IO achievement set (server/sets/io.json, Firebird 1988 on the OneLoad64 cartridge)
// under rcheevos, on synthesized RAM laid out as the game keeps it:
//   $0451 player 1's lives: 2, 1, 0, then $FF when the game is over (0 on the title screen too).
//   $0453 player 1's level, 0-3; the main loop adds one for each level completed, and the game is won at 4.
//   $044B-$044D player 1's score, BCD, high byte first.
//   $621D and $61DE hold the main loop's code.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/io.json'), 'utf8')), 'io.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '791dd2c66bf9229670438ffac7548c78';
const OVER = 0x7fffffff;

const unlocked = new Set();
const boards = [];
let over = 0;
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; over = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  codes.push(rc.activateLeaderboard(1, set.leaderboards[0].definition));
  codes.push(rc.activateAchievement(OVER, set.gameOver));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) { if (e.id === OVER) over++; else unlocked.add(e.id); }
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
const score = (n) => { const s = String(n).padStart(6, '0'); for (let i = 0; i < 3; i++) ram[0x44b + i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); frames(2); };
/** The title screen, then a new game. */
function begin() {
  activate();
  ram.set([0xde, 0x51, 0x04, 0xad], 0x621d); ram.set([0xfe, 0x53, 0x04, 0xbd], 0x61de);
  frames(2);
  ram[0x451] = 2; frames(2);
}

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements, the board and the game over parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('io-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'io-crt is not registered in test/external-assets.json';
    try { note = missingNote('io-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The four levels, and the score; the game won ends it with the score posted.
{
  begin();
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'a new game starts the board');
  for (let n = 1; n <= 3; n++) { ram[0x453] = n; score(n * 30000); }
  score(101230);
  ram[0x453] = 4; frames(2);
  expectNames('the whole game', ['A Hundred Thousand', 'Fifty Thousand', 'Into Oblivion', 'Level One', 'Level Three', 'Level Two', 'Ten Thousand', 'Twenty-Five Thousand']);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 101230, `101,230 is posted (got ${sub.map((e) => e.value).join(',') || 'nothing'})`);
  expect(over === 1, 'the game is over');
  ok('levels, score and the game won');
}

// 4. The last life lost ends the game with the score posted; a game with no score posts nothing.
{
  begin();
  score(2310); ram[0x451] = 1; frames(2); ram[0x451] = 0; frames(2); ram[0x451] = 0xff; frames(2);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 2310, `2,310 is posted (got ${sub.map((e) => e.value).join(',') || 'nothing'})`);
  begin();
  ram[0x451] = 0; frames(2); ram[0x451] = 0xff; frames(2);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0 && of(EVENT.LBOARD_CANCELED).length === 1, 'no score: the board is cancelled');
  ok('game over');
}

// 5. Without the game's code, or while it starts up with junk in memory, nothing counts.
{
  activate(); frames(2);
  ram[0x451] = 2; ram[0x453] = 1; score(50000); frames(2);
  expectNames('no code', []);
  begin();
  ram[0x451] = 32; ram[0x453] = 5; frames(2); ram[0x453] = 4; frames(2);
  expectNames('junk', []);
  ok('nothing counts without the game, or from junk');
}

// 6. Each score tier's score is what the board posts for a game ending right at the tier: a
//     post at or above it stays off the public wall until the tier is unlocked.
{
  const tiers = set.achievements.filter((a) => a.score !== undefined);
  expect(tiers.map((a) => a.title).join() === ['Ten Thousand', 'Twenty-Five Thousand', 'Fifty Thousand', 'A Hundred Thousand'].join(), `the score tiers (got ${tiers.map((a) => a.title).join()})`);
  for (const a of tiers) {
    begin(); score(a.score); ram[0x451] = 1; frames(2); ram[0x451] = 0; frames(2); ram[0x451] = 0xff; frames(2);
    expect(unlocked.has(a.id), `${a.title} unlocks at ${a.score}`);
    const sub = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED).map((e) => e.value);
    expect(sub.at(-1) === a.score, `${a.title}: a game ending at the tier posts ${a.score} (got ${sub.join(',') || 'nothing'})`);
  }
  ok('score tiers match the board');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - IO set: ${testNo} spec checks`);
