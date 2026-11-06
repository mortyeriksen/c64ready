// Spec tests for the Eye of the Beholder achievement set (server/sets/eye-of-the-beholder.json, the
// 2022 C64 port on the OneLoad64 extras EasyFlash cartridge) under rcheevos, on synthesized RAM laid
// out as the port's source declares it:
//   $2500 partyMembers_lo/hi, in RAM while the menu or the game runs (13 07 FB EF ...).
//   $6C06 levelIndex, 1 to 12. Before a game it holds what the intro left there.
//   $6C13 the party, six members of 244 bytes: +1 status (0 an empty slot), +38 level.
//   $71FD/$71FE the global script flags: bits 1 to 12 are the twelve Beholder bonuses.
//   $2272 monster_typeIndex[30], $2308 monster_direction[30]: a slain monster's direction becomes $FF.
//   Xanathar is monster type 21, on level 12.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/eye-of-the-beholder.json'), 'utf8')), 'eye-of-the-beholder.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'cfb5f97efe92166c5598c785b13bcde8';
const LEVEL = 0x6c06, FLAGS = 0x71fd, TYPES = 0x2272, DIRS = 0x2308;
const member = (i) => 0x6c13 + 244 * i;
const GAME_OVER_ID = 0x7fffffff;

const unlocked = new Set();
let over = 0;
function activate() {
  rc.clear(); unlocked.clear(); over = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  codes.push(rc.activateAchievement(GAME_OVER_ID, set.gameOver));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type !== EVENT.ACHIEVEMENT_TRIGGERED) continue;
    if (e.id === GAME_OVER_ID) over++;
    else unlocked.add(e.id);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}

/** The menu as the intro leaves memory: the game's code in place, its state bytes junk. */
function menu() {
  activate();
  ram.set([0x13, 0x07, 0xfb, 0xef, 0xe3, 0xd7, 0x6c, 0x6d, 0x6d, 0x6e, 0x6f, 0x70], 0x2500);
  ram[LEVEL] = 127; ram[FLAGS] = 0xaa; ram[FLAGS + 1] = 0xaa;
  for (let i = 0; i < 6; i++) { ram[member(i) + 1] = 0xaa; ram[member(i) + 38] = 0xaa; }
  for (let i = 0; i < 30; i++) { ram[TYPES + i] = 21; ram[DIRS + i] = 0xaa; }
  frames(2);
}
/** A new game with the four-member party of the given level, on level 1 with no monsters. */
function begin(level = 1) {
  menu();
  ram[LEVEL] = 1; ram[FLAGS] = 0; ram[FLAGS + 1] = 0;
  for (let i = 0; i < 6; i++) { ram[member(i) + 1] = i < 4 ? 1 : 0; ram[member(i) + 38] = i < 4 ? level : 0; }
  for (let i = 0; i < 30; i++) { ram[TYPES + i] = 0; ram[DIRS + i] = 0xff; }
  frames(2);
}
const go = (n) => { ram[LEVEL] = n; frames(2); };
const bonus = (bit) => { ram[FLAGS + (bit >> 3)] |= 1 << (bit & 7); frames(2); };

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements and the game over parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('eye-of-the-beholder-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'eye-of-the-beholder-crt is not registered in test/external-assets.json';
    try { note = missingNote('eye-of-the-beholder-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. Starting a game, from the junk the intro leaves, counts for nothing; nor does a loaded game that
//    begins deep down.
{
  begin(3);
  expectNames('a new game', []);
  menu();
  ram[LEVEL] = 10; frames(2);
  expectNames('a game loaded on level 10', []);
  ok('starting or loading a game counts for nothing');
}

// 4. The levels, each as the party goes down to it.
{
  begin();
  for (let n = 2; n <= 12; n++) go(n);
  expectNames('down to 12', ['Down the Drain', 'Drow Country', 'The Dwarven Ruins', 'The Inner Sanctum', "Xanathar's Domain"]);
  ok('the levels');
}

// 5. Beholder bonuses: the first, six, all twelve.
{
  begin();
  bonus(1);
  expectNames('one', ['Beholder Bonus']);
  for (const b of [2, 3, 4, 5]) bonus(b);
  expectNames('five', ['Beholder Bonus']);
  bonus(9);
  expectNames('six', ['Beholder Bonus', 'Half the Bonuses']);
  for (const b of [6, 7, 8, 10, 11]) bonus(b);
  expectNames('eleven', ['Beholder Bonus', 'Half the Bonuses']);
  bonus(12);
  expectNames('twelve', ['Beholder Bonus', 'Every Bonus', 'Half the Bonuses']);
  ok('Beholder bonuses');
}

// 6. A party of six, and characters going up levels.
{
  begin(3);
  ram[member(4) + 1] = 1; frames(2);
  expectNames('five', []);
  ram[member(5) + 1] = 1; frames(2);
  expectNames('six', ['Six Strong']);
  ram[member(2) + 38] = 6; frames(2);
  expectNames('level 6', ['Seasoned', 'Six Strong']);
  ram[member(5) + 38] = 9; frames(2);
  expectNames('level 9', ['Seasoned', 'Six Strong', 'Veteran']);
  ok('the party');
}

// 7. Slaying Xanathar on level 12 ends the game; another monster slain there does not.
{
  begin();
  for (let n = 2; n <= 12; n++) go(n);
  ram[TYPES + 3] = 7; ram[DIRS + 3] = 1; ram[TYPES + 17] = 21; ram[DIRS + 17] = 2; frames(2);
  ram[DIRS + 3] = 0xff; frames(2);
  expect(over === 0, 'another monster slain does not end the game');
  ram[DIRS + 17] = 0xff; frames(2);
  expect(names().includes('The Eye Closes') && !names().includes('Beholder Bonus Party'), 'Xanathar slain, without the bonuses');
  expect(over === 1, 'the game is over');
  ok('Xanathar');
}

// 8. Xanathar slain with all twelve bonuses.
{
  begin();
  for (let b = 1; b <= 12; b++) bonus(b);
  for (let n = 2; n <= 12; n++) go(n);
  ram[TYPES] = 21; ram[DIRS] = 0; frames(2);
  ram[DIRS] = 0xff; frames(2);
  expect(names().includes('Beholder Bonus Party'), 'the bonus party wins');
  ok('Xanathar with every bonus');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Eye of the Beholder set: ${testNo} spec checks`);
