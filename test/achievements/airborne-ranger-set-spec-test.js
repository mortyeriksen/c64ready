// Spec tests for the Airborne Ranger achievement set (server/sets/airborne-ranger.json, MicroProse 1987,
// the "+8" EasyFlash cartridge in the OneLoad64 extras) under rcheevos, on synthesized RAM laid out as
// the game keeps it:
//   $7B38 the game's code, there whenever it runs. $4F3B the debrief's code, between missions only.
//   $4347 the mission (0-11). $4349 the mission goal, 1 when achieved.
//   $4340 the veteran Ranger's roster slot (0-5), $FF for a practice Ranger.
//   $9961 the roster, 6 records of 89 bytes: +7 a space after the rank in the title line, +$50 the rank
//   (0 PFC ... 11 COL), +$51 the medals (bit 2 Bronze Star ... bit 5 Medal of Honor), +$52 on campaign.
//   A mission reuses the roster's memory; the debrief loads it back, then promotes and decorates.
//   The trainer menu's cheats: code patches, or its flags at $4637-$463E (0 or 1) left in memory.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/airborne-ranger.json'), 'utf8')), 'airborne-ranger.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'f0a023aa086382bd3382052220a000f7';
const NOTICE = 0x7ffffff0;
const rec = (slot) => 0x9961 + 89 * slot;

const unlocked = new Set();
let noticed = 0;
function activate() {
  rc.clear(); unlocked.clear(); noticed = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  codes.push(rc.activateAchievement(NOTICE, set.notices[0].memaddr));
  return codes;
}
function frame() { for (const e of rc.doFrame(ram)) if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) { if (e.id === NOTICE) noticed++; else unlocked.add(e.id); } }
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', '), exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}

const debriefCode = (on) => ram.set(on ? [0xad, 0x4d, 0x43, 0xf0] : [0, 0, 0, 0], 0x4f3b);
/** A veteran Ranger in `slot` with `rank` and `medals`, as the roster holds him. */
function record(slot, rank, medals = 0, campaign = 0) {
  const r = rec(slot);
  ram.set([...Buffer.from(`    ${['PFC', 'CPL', 'SGT', 'SSG', 'PSG', 'SGM', '2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'COL'][rank]} Ranger`)], r);
  ram[r + 0x50] = rank; ram[r + 0x51] = medals; ram[r + 0x52] = campaign;
}
/** The game running at mission selection with a veteran in `slot`. */
function begin(slot = 0, rank = 0, medals = 0, campaign = 0) {
  activate(); frames(2);
  ram.set([0xa9, 0x00, 0x8d, 0x05, 0x7c, 0x8d], 0x7b38); debriefCode(true);
  ram[0x4340] = slot; record(slot, rank, medals, campaign); frames(2);
}
/** Mission `m`: the roster's memory taken over, the goal met or not, then the debrief: the roster
 *  loaded back, then the promotion and medals written. */
function mission(m, { goal = true, rank = null, medals = null, campaign = null } = {}) {
  const slot = ram[0x4340], r = rec(slot);
  const before = { rank: ram[r + 0x50], medals: ram[r + 0x51], campaign: ram[r + 0x52] };
  ram[0x4347] = m; ram[0x4349] = 0; frames(2);
  debriefCode(false); for (let i = 0; i < 89; i++) ram[r + i] = (i * 37 + 214) & 255; frames(2);
  if (goal) { ram[0x4349] = 1; frames(2); }
  debriefCode(true); frames(1);
  record(slot, before.rank, before.medals, before.campaign); frames(1);
  if (rank !== null) ram[r + 0x50] = rank;
  if (medals !== null) ram[r + 0x51] = medals;
  if (campaign !== null) ram[r + 0x52] = campaign;
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements and the trainer notice parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('airborne-ranger-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'airborne-ranger-crt is not registered in test/external-assets.json';
    try { note = missingNote('airborne-ranger-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. Each mission's goal, achieved in the field; a failed mission counts for nothing.
{
  begin();
  for (let m = 0; m < 12; m++) mission(m, { goal: m !== 5 });
  const want = set.achievements.slice(0, 12).filter((_, m) => m !== 5).map((a) => a.title);
  expectNames('eleven of twelve', want);
  ok('mission goals');
}

// 4. Promotions, one rank a mission, and medals at the debrief; the junk a mission leaves in the
//    roster's memory, and the roster coming back, count for nothing.
{
  begin(2, 1);
  const medals = [0, 0b1, 0b11, 0b111, 0b1111, 0b11111, 0b11111, 0b11111, 0b11111, 0b111111];
  for (let rank = 2; rank <= 11; rank++) mission(rank % 12, { rank, medals: medals[rank - 2] });
  const goals = Array.from({ length: 10 }, (_, i) => set.achievements[(i + 2) % 12].title);
  expectNames('a career to colonel', [...goals, 'Bronze Star', 'Captain', 'Colonel', 'Distinguished Service Cross', 'Lieutenant Colonel', 'Medal of Honor',
    'Sergeant', 'Sergeant Major', 'Silver Star']);
  ok('promotions and medals');
}

// 5. A practice Ranger has no record, and choosing another veteran is no promotion.
{
  begin(0, 1);
  ram[0x4340] = 0xff; frames(2);
  mission(0, { rank: null });
  ram[0x4340] = 3; record(3, 9, 0b011111); frames(2);
  expectNames('practice, then a captain chosen', ['Destroy a Munitions Depot']);
  ok('a practice Ranger and a change of Ranger');
}

// 6. A campaign completed.
{
  begin(1, 6, 0, 1);
  mission(7, { campaign: 0 });
  expectNames('the last campaign mission', ['Campaign Complete', 'Liberate a P.O.W. Camp']);
  ok('a campaign completed');
}

// 7. The trainer notice: a code patch, or the menu's flags still in memory; the game's own use of
//    that memory is no trainer.
{
  begin();
  ram.set([0xff, 0xec, 0x03, 0xff, 0xf0, 0x03, 0xff, 0xc0], 0x4637); frames(2);
  expect(noticed === 0, 'the game reusing the flags is no trainer');
  ram.set([0, 0, 0, 0, 0, 0, 0, 0], 0x4637); frames(2);
  ram[0x463a] = 1; frames(2);
  expect(noticed === 1, 'the LAW rocket flag is noticed');
  begin();
  ram.set([0xad, 0x27, 0x2e, 0x4c], 0x2dc5); frames(2);
  expect(noticed === 1, 'the invulnerability patch is noticed');
  ok('the trainer notice');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Airborne Ranger set: ${testNo} spec checks`);
