// Spec tests for the Neuromancer achievement set (server/sets/neuromancer.json, Interplay 1988, the
// EasyFlash cartridge in the OneLoad64 extras) under rcheevos, on synthesized RAM laid out as the game
// keeps it:
//   $6180 and $5A96 the code that loads a room. $C330 the room (0 the Chatsubo, 1 the street).
//   $C33A-$C33C the cash. $C13B 1 once Ratz is paid. $C7C0 $FF while Shin holds the deck, 3 after.
//   $189B the ending slideshow, reached once Neuromancer is defeated. $1897 its first step.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/neuromancer.json'), 'utf8')), 'neuromancer.json');
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
const cash = (n) => { ram[0xc33a] = n & 255; ram[0xc33b] = (n >> 8) & 255; ram[0xc33c] = n >> 16; frames(2); };
const room = (n) => { ram[0xc330] = n; frames(2); };
/** The title screen's junk, then a new game in the Chatsubo with 6 credits. */
function begin() {
  activate();
  ram.fill(0xaa, 0xc100, 0xc9fd); ram.set([0xff, 0xff, 0xff, 0xaa], 0x6180); frames(2);
  ram.fill(0, 0xc100, 0xc9fd); ram[0xc7c0] = 0xff; cash(6);
  ram.set([0xad, 0x30, 0xc3, 0x8d], 0x6180); ram.set([0x8d, 0x30, 0xc3, 0x8a], 0x5a96); frames(2);
}

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
  try { file = assetPath('neuromancer-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'neuromancer-crt is not registered in test/external-assets.json';
    try { note = missingNote('neuromancer-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The game's way: Ratz paid, out on the street, the deck from Shin, the cash, the places.
{
  begin();
  expectNames('a new game', []);
  cash(100); ram[0xc13b] = 1; cash(54);
  room(1);
  room(24); ram[0xc7c0] = 3; frames(2);
  cash(999); expect(!names().includes('A Thousand Credits'), '999 credits are short of 1,000');
  cash(1000); cash(70000);
  for (const r of [18, 28, 10, 46, 21, 49]) room(r);
  expectNames('the whole way', ['A Thousand Credits', 'Freeside', 'Into the Vault', 'Off to the Stars', 'Out of the Chatsubo', 'Paid in Full', 'Ten Thousand Credits',
    'Villa Straylight', 'Your Deck Back', 'Zion Cluster']);
  ok('the whole way');
}

// 4. The street reached any other way than from the Chatsubo is no exit from it.
{
  begin();
  room(2); room(1);
  expectNames('the street from the Justice Booth', []);
  ok('the street from elsewhere');
}

// 5. Before the game's code is in, the title screen's junk counts for nothing.
{
  activate();
  ram[0xc330] = 0; frames(2); ram[0xc330] = 49; ram[0xc13b] = 1; cash(90000); ram[0xc7c0] = 3; ram[0x1897] = 1; frames(2);
  expectNames('no code', []);
  ok('nothing counts without the game');
}

// 6. The ending slideshow's first step is the win. Arriving on the beach is not.
{
  begin();
  room(49);
  expectNames('the beach', []);
  ram.set([0xee, 0x97, 0x18, 0xad], 0x189b); ram.set([0x97, 0x18, 0xc9, 0x08], 0x189f); frames(2);
  ram[0x1897] = 1; frames(2);
  expectNames('defeated', ['Neuromancer']);
  ok('Neuromancer defeated');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Neuromancer set: ${testNo} spec checks`);
