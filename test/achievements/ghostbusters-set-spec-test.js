// Spec tests for the Ghostbusters achievement set (server/sets/ghostbusters.json, Activision 1984, on
// the OneLoad64 cartridge) under rcheevos, on synthesized RAM laid out as the game keeps it:
//   $746D the code that runs the game's phases, $3A the phase: $0B choosing a car ($5C the car bought,
//   1 the hearse, 3 the high-performance), $1F a trap closed on a ghost, $25 the Marshmallow Man's
//   damage, $26 the mayor's award, $2D the bank foreclosing, $31 a game ended in profit, $36 the
//   portal closed. $51-$53 the starting balance, $57-$59 the balance, BCD, high byte first.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/ghostbusters.json'), 'utf8')), 'ghostbusters.json');
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
const bcd = (n) => { const s = String(n).padStart(6, '0'); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const money = (n) => { ram.set(bcd(n), 0x57); frames(2); };
const phase = (p) => { ram[0x3a] = p; frames(2); };
const cash = () => { const b = ram.slice(0x57, 0x5a); return +[...b].map((x) => x.toString(16).padStart(2, '0')).join(''); };
/** A ghost trapped: the trap phase, and its fee paid. */
const trap = (fee = 1000) => { phase(0x1f); money(cash() + fee); phase(0x12); };
/** The title, the account entered, then the car screen with `start` dollars. */
function begin(start = 10000, fresh = true) {
  if (fresh) activate();
  ram.set([0xa5, 0x3a, 0x0a, 0xaa, 0xbd, 0x1a, 0x38, 0x85], 0x746d);
  phase(1); phase(2);
  ram.set(bcd(start), 0x51); ram.set(bcd(start), 0x57); phase(0x0b);
}
const buy = (car, price) => { ram[0x5c] = car; money(cash() - price); phase(0x0c); phase(0x0f); phase(0x12); };

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
  try { file = assetPath('ghostbusters-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'ghostbusters-crt is not registered in test/external-assets.json';
    try { note = missingNote('ghostbusters-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. A winning game: the hearse, 25 ghosts, the Marshmallow Man averted, the portal closed, in profit.
{
  begin();
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'the car screen starts the board');
  buy(1, 4800);
  trap(); expectNames('one ghost', ['Ecto-1', 'Who You Gonna Call?']);
  for (let i = 1; i < 9; i++) trap();
  expectNames('nine ghosts', ['Ecto-1', 'Who You Gonna Call?']);
  trap();
  for (let i = 10; i < 25; i++) trap(3000);
  phase(0x26); money(cash() + 2000); phase(0x27); phase(0x12);
  phase(0x29); phase(0x2c); phase(0x36); money(cash() + 5000); phase(0x37); phase(0x38); phase(0x31);
  expectNames('the whole game', ['Bustin\' Makes Me Feel Good', 'Ecto-1', 'Fifty Grand Profit', 'Ghost Hunter', 'Ghost Master', 'In the Black', 'Marshmallow Averted',
    'Ten Grand Profit', 'The Portal Is Closed', 'Who You Gonna Call?']);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  const want = cash() - 10000;
  expect(sub.length === 1 && sub[0].value === want, `the profit, ${want}, is posted (got ${sub.map((e) => e.value).join(',') || 'nothing'})`);
  expect(over === 1, 'the game is over');
  ok('a winning game');
}

// 4. A rich account's balance is no profit, the Marshmallow Man's damage spoils the clean win, a new
//    game starts the ghost count again, and a foreclosure posts nothing.
{
  begin(60000);
  buy(3, 15000);
  phase(0x25); money(cash() - 4000); phase(0x27);
  phase(0x2c); phase(0x36); phase(0x31);
  expectNames('a rich start and damage', ['Built for Speed', 'In the Black', 'The Portal Is Closed']);
  for (let i = 0; i < 9; i++) trap();
  begin(10000, false);
  trap();
  expectNames('nine ghosts, then one in a new game', ['Built for Speed', 'In the Black', 'The Portal Is Closed', 'Who You Gonna Call?']);
  begin();
  money(3000); phase(0x2d);
  expect(of(EVENT.LBOARD_CANCELED).length === 1 && of(EVENT.LBOARD_TRIGGERED).length === 0, 'the foreclosure cancels the board');
  expect(over === 1, 'the foreclosure ends the game');
  ok('a rich account, the Marshmallow Man, a new game and a foreclosure');
}

// 5. Without the game's code nothing counts.
{
  activate(); frames(2);
  ram.set(bcd(10000), 0x51); money(90000); ram[0x5c] = 1; phase(0x0b); phase(0x0c); phase(0x1f); money(95000); phase(0x36);
  expectNames('no code', []);
  ok('nothing counts without the game');
}

// 6. Each score tier's score is what the board posts for a game ending right at the tier: a
//     post at or above it stays off the public wall until the tier is unlocked.
{
  const tiers = set.achievements.filter((a) => a.score !== undefined);
  expect(tiers.map((a) => a.title).join() === ['Ten Grand Profit', 'Fifty Grand Profit'].join(), `the score tiers (got ${tiers.map((a) => a.title).join()})`);
  for (const a of tiers) {
    begin(); money(10000 + a.score); phase(0x12); phase(0x31);
    expect(unlocked.has(a.id), `${a.title} unlocks at ${a.score}`);
    const sub = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED).map((e) => e.value);
    expect(sub.at(-1) === a.score, `${a.title}: a game ending at the tier posts ${a.score} (got ${sub.join(',') || 'nothing'})`);
  }
  ok('score tiers match the board');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Ghostbusters set: ${testNo} spec checks`);
