// Spec tests for the Elite achievement set (server/sets/elite.json, Firebird 1985 on the OneLoad64
// cartridge) under rcheevos, on synthesized RAM laid out as the C64 source's UP workspace has it:
//   $0482 MJ, $FF in witchspace. $0491 NAME, the commander's name. $0499 TP, the mission bits:
//         bit 1 the Constrictor destroyed, bits 2 and 3 both set the Thargoid plans delivered.
//   $04A2 CASH, four bytes big-endian in tenths of a credit. $04A8 GCNT, the galaxy (0-7).
//   $04A9 LASER, four views: 15 pulse, 143 beam, 151 military. $04C5 DKCMP, $04C6 GHYP, 0 if not fitted.
//   $04C9 TRIBBLE (16-bit). $04CB TALLYL, the fraction of a kill. $04CD FIST, 50 or more a fugitive.
//   $04E0 TALLY (16-bit), the kill count behind the combat rank: 8 Mostly Harmless, 16 Poor,
//         32 Average, 64 Above Average, 128 Competent, 512 Dangerous, 2560 Deadly, 6400 Elite.
//         The Constrictor alone is worth 256.
//   $8481 and $73E8 hold Elite's code from the title screen on.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/elite.json'), 'utf8')), 'elite.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'ffce8e40f9a8a07a431119b0e94f6271';

const unlocked = new Set();
function activate() {
  rc.clear(); unlocked.clear(); ram.fill(0);
  return set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
}
function frame() { for (const e of rc.doFrame(ram)) if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id); }
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}

const code = () => { ram.set([0x8d, 0x8b, 0x04, 0x4c], 0x8481); ram.set([0x8d, 0xa6, 0x04, 0xa5], 0x73e8); };
const tally = (n) => { ram[0x4e0] = n & 255; ram[0x4e1] = n >> 8; frames(2); };
const cash = (n) => { ram[0x4a2] = n >>> 24; ram[0x4a3] = (n >> 16) & 255; ram[0x4a4] = (n >> 8) & 255; ram[0x4a5] = n & 255; frames(2); };
/** A new commander, Jameson, docked at Lave with 100 credits and a pulse laser. */
function begin() {
  activate(); frames(2);
  code(); ram.set([...Buffer.from('JAMESON\r')], 0x491); ram[0x4a9] = 15; cash(1000);
}

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('elite-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'elite-crt is not registered in test/external-assets.json';
    try { note = missingNote('elite-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. While Elite starts up, its code is in place before the commander block is: nothing counts then.
{
  activate(); frames(2);
  code(); ram[0x491] = 0x18; ram[0x4a8] = 10; ram[0x499] = 141; frames(2);
  ram[0x491] = 0; ram[0x4a8] = 0; ram[0x499] = 0; frames(2);
  ram.set([...Buffer.from('JAMESON\r')], 0x491); frames(2);
  expectNames('starting up', []);
  ok('nothing counts while Elite starts up');
}

// 4. Combat ranks, as kills add up. A jump past a rank all at once, as a loaded commander brings,
//    counts for nothing; the Constrictor's 256 does count.
{
  begin();
  ram[0x4cb] = 90; frames(2);
  expectNames('a fraction', ['First Blood']);
  for (const n of [8, 16, 32, 64]) tally(n);
  expectNames('64', ['Above Average', 'Average', 'First Blood', 'Mostly Harmless', 'Poor']);
  tally(320);
  expectNames('the Constrictor', ['Above Average', 'Average', 'Competent', 'First Blood', 'Mostly Harmless', 'Poor']);
  tally(6400);
  expectNames('a jump to 6400', ['Above Average', 'Average', 'Competent', 'First Blood', 'Mostly Harmless', 'Poor']);
  begin();
  tally(511); tally(512); tally(2559); tally(2560); tally(6399); tally(6400);
  expectNames('one kill at a time', ['Dangerous', 'Deadly', 'Elite']);
  ok('combat ranks');
}

// 5. Cash, in tenths of a credit.
{
  begin();
  cash(9999);
  expectNames('999.9', []);
  cash(10000); cash(100000); cash(999999);
  expectNames('99,999.9', ['Merchant', 'Trader']);
  cash(1000000);
  expectNames('100,000', ['Merchant', 'Trader', 'Tycoon']);
  ok('cash');
}

// 6. Lasers on any view, and the equipment.
{
  begin();
  ram[0x4ab] = 143; frames(2);
  expectNames('a left beam laser', ['Beam Laser']);
  ram[0x4a9] = 151; frames(2);
  ram[0x4c5] = 0xff; frames(2);
  ram[0x4c6] = 0xff; frames(2);
  expectNames('equipment', ['Beam Laser', 'Docking Computer', 'Galactic Hyperdrive', 'Military Laser']);
  ok('lasers and equipment');
}

// 7. Galaxies: one forward at a time, around to the eighth and back to the first.
{
  begin();
  ram[0x4a8] = 3; frames(2);
  expectNames('a jump of three', []);
  ram[0x4a8] = 4; frames(2);
  expectNames('one forward', ['Another Galaxy']);
  begin();
  for (const n of [1, 2, 3, 4, 5, 6, 7, 0]) { ram[0x4a8] = n; frames(2); }
  expectNames('round all eight', ['Another Galaxy', 'The Eighth Galaxy']);
  ok('galaxies');
}

// 8. Missions, Trumbles, witchspace and the law.
{
  begin();
  ram[0x499] = 0b01; frames(2);
  expectNames('mission 1 under way', []);
  ram[0x499] = 0b11; frames(2);
  expectNames('the Constrictor', ['Constrictor']);
  ram[0x499] = 0b0110; frames(2);
  expectNames('plans picked up', ['Constrictor']);
  ram[0x499] = 0b1110; frames(2);
  ram[0x4c9] = 1; frames(2);
  ram[0x482] = 0xff; frames(2);
  ram[0x4cd] = 64; frames(2);
  expectNames('the rest', ['Constrictor', 'Fugitive', 'Thargoid Plans', 'Trouble with Trumbles', 'Witchspace']);
  ok('missions and the rest');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Elite set: ${testNo} spec checks`);
