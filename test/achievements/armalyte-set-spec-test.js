// Spec tests for the Armalyte achievement set (server/sets/armalyte.json, Thalamus 1988, the
// MultiLoad64 EasyFlash cartridge) under rcheevos, on synthesized RAM laid out as the game keeps it:
//   $AE42 and $AE4C the code that counts a level done. $B002 the level, 0-7, then 8 for the ending.
//   $B005 player 1's lives left (3 at the start, 0 the last). $B00D the shield (3, 2, 1; 0 at the
//   game over). $B007-$B00C the score's digits, one a byte, in hundreds.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/armalyte.json'), 'utf8')), 'armalyte.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = set.hashes[0].hash;
const OVER = 0x7fffffff;

const unlocked = new Set(), boards = [];
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
const score = (n) => { ram.set([...String(n / 100).padStart(6, '0')].map(Number), 0xb007); frames(2); };
/** The title, then a new game: three lives, a full shield, the first level. */
function begin() {
  activate();
  ram.set([0xad, 0x02, 0xb0, 0xc9], 0xae42); ram.set([0xee, 0x02, 0xb0, 0xa9], 0xae4c);
  ram[0xb005] = 0; frames(2);
  ram[0xb005] = 3; ram[0xb00d] = 3; frames(2);
}
const levelDone = () => { ram[0xb002]++; frames(2); };
const lifeLost = () => { ram[0xb00d] = 3; ram[0xb005]--; frames(2); };

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(/^[0-9a-f]{32}$/.test(HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements, the board and the game over parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('armalyte-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'armalyte-crt is not registered in test/external-assets.json';
    try { note = missingNote('armalyte-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The whole game without a life lost on the first level; the ending posts the score.
{
  begin();
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'a new game starts the board');
  score(99900); levelDone();
  expectNames('the first level', ['Flawless Start', 'First Level']);
  score(100000); lifeLost(); ram[0xb005] = 3; frames(2);
  for (let l = 2; l <= 7; l++) { score(l * 150000); levelDone(); }
  score(4999900); expect(!names().includes('Top of the Table'), '4,999,900 is short of the table');
  score(5123400); levelDone();
  expectNames('the whole game', ['100,000', '500,000', 'A Million', 'Armalyte', 'Extra Life', 'Fifth Level', 'First Level', 'Flawless Start', 'Fourth Level',
    'Second Level', 'Seventh Level', 'Sixth Level', 'Third Level', 'Top of the Table']);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 5123400, `5,123,400 is posted (got ${sub.map((e) => e.value).join(',') || 'nothing'})`);
  expect(over === 1, 'the game is over');
  ok('the whole game');
}

// 4. A life lost on the first level spoils the flawless start; the last life lost ends the game.
{
  begin();
  score(1200); lifeLost(); levelDone();
  expectNames('a life lost', ['First Level']);
  lifeLost(); lifeLost();
  ram[0xb00d] = 0; frames(2);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 1200, `1,200 is posted (got ${sub.map((e) => e.value).join(',') || 'nothing'})`);
  expect(over === 1, 'the game is over');
  ok('lives lost and the game over');
}

// 5. Without the game's code nothing counts.
{
  activate(); frames(2);
  ram[0xb005] = 3; ram[0xb002] = 7; frames(2); ram[0xb002] = 8; score(9000000);
  expectNames('no code', []);
  ok('nothing counts without the game');
}

// 6. Each score tier's score is what the board posts for a game ending right at the tier: a
//     post at or above it stays off the public wall until the tier is unlocked.
{
  const tiers = set.achievements.filter((a) => a.score !== undefined);
  expect(tiers.map((a) => a.title).join() === ['100,000', '500,000', 'A Million', 'Top of the Table'].join(), `the score tiers (got ${tiers.map((a) => a.title).join()})`);
  for (const a of tiers) {
    begin(); score(a.score); lifeLost(); lifeLost(); lifeLost(); ram[0xb00d] = 0; frames(2);
    expect(unlocked.has(a.id), `${a.title} unlocks at ${a.score}`);
    const sub = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED).map((e) => e.value);
    expect(sub.at(-1) === a.score, `${a.title}: a game ending at the tier posts ${a.score} (got ${sub.join(',') || 'nothing'})`);
  }
  ok('score tiers match the board');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Armalyte set: ${testNo} spec checks`);
