// Spec tests for the Pitstop II achievement set (server/sets/pitstop-ii.json, Epyx 1984, on the
// OneLoad64 cartridge) under rcheevos, on synthesized RAM laid out as the game keeps it:
//   $3C13 and $3C0B the code that counts the laps. The menu's choices: $039E the drivers (0 ONE),
//   $039F the track, $03A0 the laps (0 three, 2 nine), $03A1 the difficulty (2 PRO).
//   $78 the laps to run (123 in the menu). $61EE and $61EF the laps each car has run.
//   $61F2 car 1's minutes, $61F4 59 less its seconds.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/pitstop-ii.json'), 'utf8')), 'pitstop-ii.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = set.hashes[0].hash;
const OVER = 0x7fffffff;

const unlocked = new Set(), boards = [];
let over = 0;
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; over = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  for (const l of set.leaderboards) codes.push(rc.activateLeaderboard(l.id, l.definition));
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
/** The menu, then a race on `track` with the given choices, its clock started. */
function race(track, { laps = 0, level = 0, drivers = 0, fresh = true } = {}) {
  if (fresh) activate();
  ram.set([0xbd, 0xee, 0x61, 0xc5], 0x3c13); ram.set([0xfe, 0xee, 0x61, 0xa9], 0x3c0b);
  ram[0x78] = 123; frames(2);
  ram[0x39e] = drivers; ram[0x39f] = track; ram[0x3a0] = laps; ram[0x3a1] = level; frames(2);
  ram[0x78] = laps * 3 + 3; ram[0x61ee] = 0; ram[0x61ef] = 0; ram[0x61f2] = 0; ram[0x61f4] = 59; frames(2);
  ram[0x61f4] = 58; frames(2);
}
/** Car `car` runs its laps to the line, with car 1's clock at `secs` when it finishes. */
function finish(car, secs = 0) {
  for (let l = 1; l <= ram[0x78]; l++) {
    if (car === 0 && l === ram[0x78]) { ram[0x61f2] = Math.floor(secs / 60); ram[0x61f4] = 59 - (secs % 60); }
    ram[0x61ee + car] = l; frames(2);
  }
}

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(/^[0-9a-f]{32}$/.test(HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements, ${set.leaderboards.length} boards and the game over parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('pitstop-ii-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'pitstop-ii-crt is not registered in test/external-assets.json';
    try { note = missingNote('pitstop-ii-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. A three-lap win at each track: its achievement, and its board posting car 1's time.
{
  for (let t = 0; t < 6; t++) {
    race(t);
    expect(of(EVENT.LBOARD_STARTED).length === 1 && of(EVENT.LBOARD_STARTED)[0].id === t + 1, `track ${t}: its board starts`);
    finish(0, 100 + t);
    const sub = of(EVENT.LBOARD_TRIGGERED);
    expect(sub.length === 1 && sub[0].id === t + 1 && sub[0].value === 100 + t, `track ${t}: ${100 + t} seconds posted (got ${sub.map((e) => `${e.id}:${e.value}`).join(',') || 'nothing'})`);
    expect(over === 1, `track ${t}: the race is over`);
    expectNames(`track ${t}`, [set.achievements[t].title]);
  }
  ok('a win at each track');
}

// 4. Nine laps on PRO, and a win on SEMI-PRO; a six-lap race starts no board.
{
  race(5, { laps: 2, level: 2 });
  expect(of(EVENT.LBOARD_STARTED).length === 0, 'nine laps start no board');
  finish(0, 500);
  expectNames('nine laps on PRO', ['Endurance', 'Pro', 'Pro Endurance', 'Semi-Pro', 'Winner at Watkins Glen']);
  race(1, { laps: 1, level: 1 });
  finish(0, 300);
  expectNames('six laps on SEMI-PRO', ['Semi-Pro', 'Winner at Hockenheim']);
  ok('PRO, SEMI-PRO and nine laps');
}

// 5. Beaten by the Robodriver, or racing a second driver: no win, though the time still posts.
{
  race(2);
  finish(1); finish(0, 120);
  expectNames('beaten', []);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 1, 'car 1\'s time still posts');
  race(3, { drivers: 1 });
  finish(0, 110);
  expectNames('two drivers', []);
  ok('a loss and a two-driver race');
}

// 6. Back to the menu cancels the board; the menu's junk counts for nothing.
{
  race(4);
  ram[0x78] = 123; frames(2);
  expect(of(EVENT.LBOARD_CANCELED).length === 1, 'the menu cancels the board');
  activate(); frames(2);
  ram[0x78] = 3; ram[0x61ee] = 3; ram[0x61ef] = 0; frames(2);
  expectNames('no code', []);
  ok('the menu');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Pitstop II set: ${testNo} spec checks`);
