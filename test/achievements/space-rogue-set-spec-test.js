// Spec tests for the Space Rogue achievement set (server/sets/space-rogue.json, Origin 1989, the
// EasyFlash cartridge in the OneLoad64 extras) under rcheevos, on synthesized RAM laid out as the game
// keeps it:
//   $1870 the code that loads the game's resources. $0054 the mode: 0 in flight, 1 as the ship docks,
//   4 docked, 76 on the title. $062E the object the ship is in (4 a starbase). $071E/$071F the sector.
//   $0728 the credits, 16 bits. $072A the repute, 0 unknown to 5 invincible.
//   $071D the star system, 9 Ja-Karn. $7094 the landing check. $17E9/$17EB the WON file name.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/space-rogue.json'), 'utf8')), 'space-rogue.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = set.hashes[0].hash;

const unlocked = new Set();
function activate() {
  rc.clear(); unlocked.clear(); ram.fill(0);
  return set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
}
function frame() { for (const e of rc.doFrame(ram)) if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id); }
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', '), exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const credits = (n) => { ram[0x728] = n & 255; ram[0x729] = n >> 8; frames(2); };
/** The title's junk, then a new game in flight with 1,500 credits. */
function begin() {
  activate();
  ram.fill(0x20, 0x403, 0x803); ram[0x54] = 76; ram.set([0x48, 0x98, 0xa2, 0x00, 0x20, 0x93, 0x18, 0x68], 0x1870); frames(2);
  ram.fill(0, 0x403, 0x803); ram[0x54] = 0; credits(1500); ram[0x71e] = 26; ram[0x71f] = 5;
  ram.set([0xad, 0x1d, 0x07, 0xc9, 0x09, 0xd0, 0x03, 0x4c], 0x7094); frames(2);
}
/** Docking at the base in sector x,y: into its object, then the mode through 1 to 4. */
function dock(x, y) { ram[0x71e] = x; ram[0x71f] = y; frames(2); ram[0x62e] = 4; frames(1); ram[0x54] = 1; frames(3); ram[0x54] = 4; frames(2); }
function undock() { ram[0x54] = 0; ram[0x62e] = 0; frames(2); }

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(/^[0-9a-f]{32}$/.test(HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('space-rogue-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'space-rogue-crt is not registered in test/external-assets.json';
    try { note = missingNote('space-rogue-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. A career: docked at Hiathra, then elsewhere; trading up the credits; every repute in turn.
{
  begin();
  expectNames('a new game from the title\'s junk', []);
  dock(13, 19);
  expectNames('Hiathra', ['Docking Privileges', 'Hiathra']);
  undock(); dock(20, 3);
  credits(4999); expect(!names().includes('Five Thousand Credits'), '4,999 is short of 5,000');
  credits(5000); credits(20000); credits(50000);
  for (let r = 1; r <= 5; r++) { ram[0x72a] = r; frames(2); }
  expectNames('the career', ['Ace', 'Deadly', 'Docking Privileges', 'Fierce', 'Fifty Thousand Credits', 'Five Thousand Credits', 'Hiathra', 'Invincible',
    'Pesky', 'Twenty Thousand Credits']);
  ok('a career');
}

// 4. Flying past a base, or into the Malir Gate, is no docking; a repute out of range counts nothing.
{
  begin();
  ram[0x71e] = 13; ram[0x71f] = 19; ram[0x62e] = 5; frames(2); ram[0x62e] = 0; frames(2);
  ram[0x72a] = 32; frames(2);
  expectNames('no docking', []);
  ok('no docking, and junk repute');
}

// 5. On the title, with the game's code in, the junk counts for nothing.
{
  activate();
  ram.set([0x48, 0x98, 0xa2, 0x00, 0x20, 0x93, 0x18, 0x68], 0x1870); ram[0x54] = 76; frames(2);
  credits(0x2020); ram[0x72a] = 1; ram[0x62e] = 4; frames(2);
  expectNames('the title', []);
  ram[0x71d] = 9; ram[0x17e9] = 220; ram[0x17eb] = 7; frames(2);
  expectNames('the title', []);
  ok('nothing counts on the title');
}

// 6. Landing in Ja-Karn loads the ending. Repute, and any other system, do not.
{
  begin();
  ram[0x72a] = 5; frames(2);
  ram[0x71d] = 9; ram[0x17eb] = 7; frames(2);
  ram[0x17e9] = 0xa0; frames(2);
  expect(!names().includes('Ja-Karn'), 'another file in Ja-Karn is not the ending');
  ram[0x71d] = 8; ram[0x17e9] = 220; frames(2);
  expect(!names().includes('Ja-Karn'), 'the ending file outside Ja-Karn is not the win');
  ram[0x71d] = 9; ram[0x17e9] = 0xa0; frames(2);
  ram[0x17e9] = 220; frames(2);
  expect(names().includes('Ja-Karn'), 'landing in Ja-Karn loads the ending');
  ok('the Manchi egg home');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Space Rogue set: ${testNo} spec checks`);
