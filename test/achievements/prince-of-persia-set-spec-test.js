// Spec tests for the Prince of Persia achievement set (server/sets/prince-of-persia.json, the 2011
// C64 port on the OneLoad64 extras EasyFlash cartridge) under rcheevos, on synthesized RAM laid out
// as the Apple II source declares it, which the port keeps:
//   $03F4 level: 0 the demo, 1 to 12, 13 Jaffar's level, 14 the princess, $FF on the title screen.
//   $0300 MinLeft, the minutes left in BCD ($60 at the start). $030A gotsword.
//   $0086 exitopen: on level 13, set when Jaffar dies. $00D0 MaxKidStr, the strength meter (3 at first).
//   $184F and $2D86 hold the game's code while it runs.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/prince-of-persia.json'), 'utf8')), 'prince-of-persia.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '6cefa54b8a047d565680784fba4c71e6';
const LEVEL = 0x3f4, MIN = 0x300;

const unlocked = new Set();
const boards = [];
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  for (const l of set.leaderboards) codes.push(rc.activateLeaderboard(l.id, l.definition));
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
const titles = (ids) => ids.map((i) => set.achievements[i - 1].title);
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const of = (t) => boards.filter((e) => e.type === t);

const bcd = (n) => ((n / 10) | 0) * 16 + (n % 10);
/** The title screen, then a new game: level 1, an hour left, a strength of three. */
function begin() {
  activate();
  ram.set([0x85, 0x3e, 0x20, 0x54], 0x184f); ram.set([0xa5, 0x4b, 0xc9, 0x0f], 0x2d86);
  ram[LEVEL] = 0xff; frames(2);
  ram[LEVEL] = 1; frames(1);
  ram[MIN] = 0x60; ram[0xd0] = 3; frames(2);
}
const go = (n) => { ram[LEVEL] = n; frames(2); };

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements and the board parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('prince-of-persia-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'prince-of-persia-crt is not registered in test/external-assets.json';
    try { note = missingNote('prince-of-persia-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The demo (level 0) and a saved game loaded from the title count for nothing.
{
  begin();
  go(0); ram[0x30a] = 1; frames(2); go(1);
  go(0xff); go(7);
  expectNames('the demo and a loaded game', []);
  ok('the demo and a loaded game count for nothing');
}

// 4. The sword, each level, Jaffar and the princess.
{
  begin();
  ram[0x30a] = 1; frames(2);
  for (let n = 2; n <= 13; n++) go(n);
  ram[0x86] = 1; frames(2);
  ram[MIN] = bcd(12); go(14);
  const want = titles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  expectNames('the whole game', want);
  ok('the sword, the levels, Jaffar and the princess');
}

// 5. Strength from potions.
{
  begin();
  ram[0xd0] = 4; frames(2);
  expectNames('four', ['Stronger']);
  ram[0xd0] = 5; frames(2); ram[0xd0] = 6; frames(2);
  expectNames('six', ['Six Lives', 'Stronger']);
  ok('strength');
}

// 6. The board: minutes left at the princess, from a new game. Time to Spare with 30 or more.
{
  begin();
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'a new game starts the board');
  for (let n = 2; n <= 13; n++) go(n);
  ram[MIN] = bcd(31); go(14);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 31, `31 minutes posts 31 (got ${sub.map((e) => e.value).join(',') || 'nothing'})`);
  expect(names().includes('Time to Spare'), 'Time to Spare with 31 minutes left');
  begin();
  go(4); go(0xff);
  expect(of(EVENT.LBOARD_CANCELED).length === 1, 'back to the title cancels it');
  ok('the board');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Prince of Persia set: ${testNo} spec checks`);
