// Spec tests for the Defender of the Crown achievement set (server/sets/defender-of-the-crown.json, the
// Cinemaware C64 game on its EasyFlash cartridge) under rcheevos, on synthesized RAM laid out as the
// game keeps it:
//   $42 month (1-12) and $43/$44 year, little endian. The character screen holds 00 00 0B; choosing a
//         knight sets September 1199 ($09 $AF $04), and the first turn is October 1199.
//   $7D the player's gold (the other five lords' follow at $7E-$82).
//   $D0-$E2 one byte per territory: the owner in the low nibble (0 the player, 1-5 the other lords,
//         7 nobody), $C0 set on a castle, and $80 set for a moment while a battle is drawn there.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/defender-of-the-crown.json'), 'utf8')), 'defender-of-the-crown.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = '9bb7905207d10094d3f3fda527d0d1ac';
const MONTH = 0x42, YEAR = 0x43, GOLD = 0x7d, TERR = 0xd0;
// The map at the start with Wilfred: his castle at $D1, the other lords' castles and neutral land.
const START_MAP = [0x07, 0xc0, 0x07, 0x07, 0x07, 0xc2, 0x07, 0x07, 0xc3, 0x07, 0x07, 0xc4, 0x07, 0xc5, 0x07, 0xc1, 0x07, 0x07, 0x07];

const unlocked = new Set();
function activate() {
  rc.clear(); unlocked.clear(); ram.fill(0);
  return set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
}
function frame() { for (const e of rc.doFrame(ram)) if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id); }
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const has = (title) => unlocked.has(id[title]);
function setDate(month, year) { ram[MONTH] = month; ram[YEAR] = year & 255; ram[YEAR + 1] = year >> 8; }

/** The character screen: the date bytes hold 00 00 0B, the map table junk with zeros in it. */
function characterScreen() { setDate(0, 0); ram[YEAR + 1] = 0x0b; ram.set([0x00, 0xe0, 0x05, 0x1c, 0x00, 0x27, 0x0c, 0x45, 0x00], TERR); ram[GOLD] = 0x3a; frames(10); }
/** A knight is chosen: September 1199, the map set up, then the first turn in October. */
function start() { setDate(9, 1199); ram.set(START_MAP, TERR); ram[GOLD] = 8; frames(30); setDate(10, 1199); frames(30); }
function month() { const m = ram[MONTH] === 12 ? 1 : ram[MONTH] + 1; setDate(m, (ram[YEAR + 1] << 8 | ram[YEAR]) + (m === 1 ? 1 : 0)); frames(20); }

// 1. Every condition parses and the set names the cartridge; no leaderboard (no score to rank).
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  expect(!(set.leaderboards ?? []).length, 'achievements only');
  ok(`all ${codes.length} achievements parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('defender-of-the-crown-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'defender-of-the-crown-crt is not registered in test/external-assets.json';
    try { note = missingNote('defender-of-the-crown-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the EasyFlash cartridge hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the EasyFlash cartridge hashes to the listed hash'); }
}

// 3. The intro, the character screen and the start of a game unlock nothing.
{
  activate(); characterScreen(); ram[GOLD] = 200; frames(5); characterScreen(); start();
  expect(unlocked.size === 0, `nothing before play (got ${[...unlocked]})`);
  ok('nothing at the start');
}

// 4. Territories: one taken by the player, not one taken by another lord, not a battle marker.
{
  activate(); characterScreen(); start();
  ram[TERR + 2] = 0x02; frames(5);
  expect(!has('New Lands'), 'another lord taking land is not the player\'s');
  ram[TERR + 4] = 0x84; frames(1); ram[TERR + 4] = 0x80; frames(1); ram[TERR + 4] = 0x07; frames(5);
  expect(!has('New Lands'), 'the battle marker is not a conquest');
  ram[TERR + 6] = 0x00; frames(3);
  expect(has('New Lands'), 'New Lands when a territory turns 0 from another owner');
  expect(!has('Castle Taker'), 'not a castle');
  ram[TERR + 11] = 0xc0; frames(3);
  expect(has('Castle Taker'), 'Castle Taker when a lord\'s castle turns $C0');
  ok('conquests');
}

// 5. Gold.
{
  activate(); characterScreen(); start();
  ram[GOLD] = 49; frames(2);
  expect(!has('Full Coffers'), '49 gold is short');
  ram[GOLD] = 50; frames(2);
  expect(has('Full Coffers') && !has('Treasure House'), 'Full Coffers at 50');
  ram[GOLD] = 150; frames(2);
  expect(has('Treasure House'), 'Treasure House at 150');
  ok('gold');
}

// 6. Time: October 1200 and October 1201, reached month by month.
{
  activate(); characterScreen(); start();
  for (let i = 0; i < 11; i++) month();
  expect(ram[MONTH] === 9 && !has('A Year in the Saddle'), 'September 1200 is not a year');
  month();
  expect(has('A Year in the Saddle') && !has('Long Campaign'), 'A Year in the Saddle in October 1200');
  for (let i = 0; i < 12; i++) month();
  expect(has('Long Campaign'), 'Long Campaign in October 1201');
  ok('time');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - defender-of-the-crown set: ${testNo} checks`);
