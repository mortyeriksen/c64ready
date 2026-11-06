// Spec tests for the Ultima IV achievement set (server/sets/ultima-iv.json, Ultima IV Remastered v2.2
// on its EasyFlash cartridge) under rcheevos, on synthesized RAM laid out as the remaster's source
// (github.com/MagerValp/u4remastered) keeps it:
//   $0800 the game's jump table. $001B the game mode, $001F the party's size, $2C-$2F the turns (BCD).
//   $AB00-$AB07 the virtues (BCD; 0 once elevated from 99), $AB0C the stones, $AB0D the runes,
//   $AB0E the bell/book/candle, $AB0F the key's parts, $AB15-$AB17 the horn, wheel and skull.
//   The end game at $8800; $907D set as it prints the turns of a game won.
//   The trainer's code patches, and the save editor's program at $0801.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/ultima-iv.json'), 'utf8')), 'ultima-iv.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = set.hashes[0].hash;
const OVER = 0x7fffffff, NOTICE = 0x7ffffff0;

const unlocked = new Set(), notices = [], boards = [];
let over = 0;
function activate() {
  rc.clear(); unlocked.clear(); notices.length = 0; boards.length = 0; over = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  codes.push(rc.activateLeaderboard(1, set.leaderboards[0].definition));
  codes.push(rc.activateAchievement(OVER, set.gameOver));
  for (const n of set.notices) codes.push(rc.activateAchievement(NOTICE + n.id, n.memaddr));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) {
      if (e.id === OVER) over++;
      else if (e.id > NOTICE) notices.push(set.notices.find((n) => n.id === e.id - NOTICE).title);
      else unlocked.add(e.id);
    } else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
const of = (t) => boards.filter((e) => e.type === t);
const CODE = { 0x48a1: [0xac, 0xef, 0x48], 0x6500: [0x85, 0x58], 0x5518: [0x20, 0x50, 0x84], 0x5551: [0x03], 0x57cd: [0xa0, 0x09, 0x20], 0x66fc: [0x57, 0x83], 0x424e: [0xf7, 0x41], 0x59ce: [0x20, 0x21, 0x08] };
/** The menu, then a new game: the jump table, the gypsy's virtues, a party of one in Britannia. */
function begin() {
  activate();
  ram.set([0x4c, 0xad, 0x0a, 0x4c, 0x08, 0x0a, 0x4c, 0x99], 0x0800); frames(2);
  for (const [a, b] of Object.entries(CODE)) ram.set(b, +a);
  ram.set([0x65, 0x60, 0x50, 0x55, 0x55, 0x50, 0x50, 0x50], 0xab00); ram[0x1f] = 1; ram[0x1b] = 1; frames(2);
}
const set1 = (addr, mask) => { ram[addr] |= mask; frames(2); };
/** A shrine: the virtue raised to 99, then elevated to 0. */
const elevate = (i) => { ram[0xab00 + i] = 0x99; frames(2); ram[0xab00 + i] = 0; frames(2); };
/** The end game: loaded from $8800 upward, then the last answer and the turns printed. */
function codex(turns) {
  const s = String(turns).padStart(8, '0'); for (let i = 0; i < 4; i++) ram[0x2c + i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  ram[0x1b] = 0; ram.set([0xa9, 0xcc, 0xa2, 0x9b], 0x8800); frames(1); ram.set([0x4c, 0x58, 0x90, 0xa2], 0x9058); frames(2);
  ram[0x907d] = 2; frames(2);
}

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(/^[0-9a-f]{32}$/.test(HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements, the board, the game over and ${set.notices.length} notices parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('ultima-iv-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'ultima-iv-crt is not registered in test/external-assets.json';
    try { note = missingNote('ultima-iv-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The whole quest: every rune and stone, the bell, book and candle, the horn, wheel and skull, the
//    key, eight elevations, eight companions, then the Codex; the board posts the turns.
{
  begin();
  expect(names().length === 0, 'a new game unlocks nothing');
  for (let b = 0; b < 8; b++) { set1(0xab0d, 1 << b); set1(0xab0c, 1 << b); }
  for (const m of [4, 2, 1]) set1(0xab0e, m);
  for (const a of [0xab15, 0xab16, 0xab17]) { ram[a] = 1; frames(2); }
  ram[0xab17] = 0xff; frames(2);
  for (const m of [4, 2, 1]) set1(0xab0f, m);
  for (let i = 0; i < 8; i++) elevate(i);
  for (let p = 2; p <= 8; p++) { ram[0x1f] = p; frames(2); }
  expect(of(EVENT.LBOARD_STARTED).length === 0, 'the board waits for the end game');
  codex(4321);
  expect(names().length === set.achievements.length, `every achievement (missing ${set.achievements.filter((a) => !unlocked.has(a.id)).map((a) => a.title).join(', ')})`);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 4321, `4,321 turns are posted (got ${sub.map((e) => e.value).join(',') || 'nothing'})`);
  expect(over === 1, 'the game is over');
  expect(notices.length === 0, 'no notice');
  ok('the whole quest');
}

// 4. A virtue lost from 0 ("thou hast lost an eighth") and set again is no elevation; the end game
//    left without its last answer cancels the board.
{
  begin();
  ram[0xab00] = 0; frames(2);
  ram[0xab00] = 0x98; frames(2); ram[0xab00] = 0x50; frames(2);
  expect(names().length === 0, `no elevation without 99 (got ${names().join(', ')})`);
  ram.set([0xa9, 0xcc, 0xa2, 0x9b], 0x8800); frames(1); ram.set([0x4c, 0x58, 0x90, 0xa2], 0x9058); frames(2);
  ram.fill(0, 0x8800, 0x8804); frames(2);
  expect(of(EVENT.LBOARD_STARTED).length === 1 && of(EVENT.LBOARD_CANCELED).length === 1, 'the board starts and is cancelled');
  ok('no false elevation, and the end game left');
}

// 5. The trainer: each of its patches is noticed; so is the save editor.
{
  const patches = [[0x48a1, [0x4c, 0xdd, 0x48]], [0x6500, [0x38, 0x60]], [0x5518, [0x38, 0xea, 0xea]], [0x5551, [0x0d]], [0x57cd, [0x4c, 0xd7, 0x57]],
    [0x66fc, [0xd0, 0xa6]], [0x424e, [0x3e, 0x02]], [0x59ce, [0x20, 0x00, 0xf2]]];
  for (const [a, b] of patches) {
    begin(); ram.set(b, a); frames(2);
    expect(notices.join() === 'Trainer on', `the patch at $${a.toString(16)} is noticed (got ${notices.join() || 'nothing'})`);
  }
  activate(); frames(2);
  ram.set([0xa2, 0x19, 0xb5, 0x02, 0x9d, 0xea, 0x4f, 0xca], 0x080d); frames(2);
  expect(notices.join() === 'Save game editor', `the save editor is noticed (got ${notices.join() || 'nothing'})`);
  ok('the trainer and the save editor');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Ultima IV set: ${testNo} spec checks`);
