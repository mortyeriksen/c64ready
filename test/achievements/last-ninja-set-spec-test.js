// Spec tests for The Last Ninja achievement set (server/sets/last-ninja.json, System 3's 1987 game on
// the MultiLoad64 EasyFlash cartridge) under rcheevos, on synthesized RAM laid out as the game keeps
// it: each level's data loads at $0800 with its own letter at $0805 ('A' the Wastelands, 'B' the
// Wilderness, 'C' the Palace Gardens, 'D' the Dungeons, 'E' the Palace, 'F' the Inner Sanctum) and
// the next level's letter at $0804 (F names 'A'). While a level's files load, $0805 holds whatever
// the files bring (junk such as $9E, $DF, $FF) before the new letter arrives.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/last-ninja.json'), 'utf8')), 'last-ninja.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = '504708239b910d8dd5c75e29e3dc346f';
const HERE = 0x805, NEXT = 0x804;
const LEVELS = 'ABCDEF';

const unlocked = new Set();
function activate() {
  rc.clear(); unlocked.clear(); ram.fill(0);
  return set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
}
function frame() { for (const e of rc.doFrame(ram)) if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id); }
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const has = (title) => unlocked.has(id[title]);

/** A level load: junk at $0805 while the files arrive, then the level's letter and the next one's. */
function load(letter, junk = [0x9e, 0xdf, 0xff]) {
  for (const j of junk) { ram[HERE] = j; frames(3); }
  const i = LEVELS.indexOf(letter);
  ram[HERE] = letter.charCodeAt(0); ram[NEXT] = LEVELS.charCodeAt((i + 1) % 6); frames(20);
}

// 1. Every condition parses, the set names the cartridge, and there is no leaderboard (no score).
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the MultiLoad64 cartridge');
  expect(!(set.leaderboards ?? []).length, 'no leaderboard: the game keeps no score');
  ok(`all ${codes.length} achievements parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('last-ninja-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'last-ninja-crt is not registered in test/external-assets.json';
    try { note = missingNote('last-ninja-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the EasyFlash cartridge hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the EasyFlash cartridge hashes to the listed hash'); }
}

// 3. Power-on, the title and the first level: nothing.
{
  activate();
  ram[HERE] = 0x85; frames(10);
  load('A');
  load('A');
  expect(unlocked.size === 0, `loading the Wastelands unlocks nothing (got ${[...unlocked]})`);
  ok('the title and level 1');
}

// 4. Each later level unlocks as it loads, and only that one.
{
  activate(); load('A');
  const titles = { B: 'Into the Wilderness', C: 'Palace Gardens', D: 'Into the Dungeons', E: 'The Palace', F: 'Inner Sanctum' };
  for (const L of 'BCDEF') {
    expect(!has(titles[L]), `${titles[L]} not before level ${L} loads`);
    load(L);
    expect(has(titles[L]), `${titles[L]} when level ${L} loads`);
  }
  expect(unlocked.size === 5, 'five level achievements');
  ok('levels 2 to 6');
}

// 5. Junk while loading that looks like a level letter, without the matching next letter, is no level.
{
  activate(); load('A');
  ram[HERE] = 0x44; frames(3);            // 'D' with 'B' still at $0804
  ram[HERE] = 0x46; ram[NEXT] = 0x43; frames(3);   // 'F' with 'C'
  expect(unlocked.size === 0, `half-loaded letters are not levels (got ${[...unlocked]})`);
  ok('loading junk');
}

// 6. Stepping Stones: in the Wastelands the river is screen 11 ($A2), between screen 10 and screen 12 on
// the far bank; the lives are at $9B. Crossing from 10 over 11 to 12 without a life lost unlocks it.
{
  const SCREEN = 0xa2, LIVES = 0x9b;
  const to = (n, f = 10) => { ram[SCREEN] = n; frames(f); };
  const fresh = () => { activate(); load('A'); ram[LIVES] = 3; to(9); };

  fresh(); to(10); to(11); to(12);
  expect(has('Stepping Stones'), 'crossing from screen 10 over the river to screen 12 unlocks it');

  fresh(); to(10); to(11); ram[LIVES] = 2; frames(10); to(12);
  expect(!has('Stepping Stones'), 'not when a life is lost on the river, even after reaching the far bank');

  fresh(); to(10); to(11); to(10); to(9); to(12, 2); to(11); to(12);
  expect(!has('Stepping Stones'), 'not when coming back to the river from the far bank');

  fresh(); to(10); to(11); to(10); to(11); to(12);
  expect(has('Stepping Stones'), 'turning back and trying again still counts');

  activate(); load('A'); load('B'); ram[LIVES] = 3; to(10); to(11); to(12);
  expect(!has('Stepping Stones'), 'not on another level\'s screens 10 to 12');
  ok('Stepping Stones: the river crossed without a life lost');
}

// 7. Weapons: the inventory is a counter per item at $03EC + item ($03F7 sword, $03F9 nunchaku, $03FA
// shuriken, $03FB smoke bombs); a pick-up sets it from 0 to 1, to $85 for the shuriken and to 3 for the
// smoke bombs. The cartridge's start-up fills the area with junk, and the level start zeroes it.
{
  const weapons = [['The Sword', 0x3f7, 1], ['Nunchaku', 0x3f9, 1], ['Throwing Stars', 0x3fa, 0x85], ['Smoke Screen', 0x3fb, 3]];
  activate();
  ram[HERE] = 0x85; for (let a = 0x3ec; a < 0x400; a++) ram[a] = (a * 37) & 0xff; frames(5);   // start-up junk
  for (const [, at, v] of weapons) { ram[at] = v; frames(2); }
  expect(unlocked.size === 0, `junk while the cartridge starts unlocks nothing (got ${[...unlocked]})`);
  load('A'); for (let a = 0x3ec; a < 0x400; a++) ram[a] = 0; frames(5);
  for (const [title, at, v] of weapons) {
    expect(!has(title), `${title} not before its pick-up`);
    ram[at] = v; frames(3);
    expect(has(title), `${title} when it is picked up`);
    expect(unlocked.size === weapons.findIndex(([t]) => t === title) + 1, `${title} alone`);
  }
  ok('each weapon on its pick-up, not on junk');

  activate(); load('A'); for (let a = 0x3ec; a < 0x400; a++) ram[a] = 0; frames(5);
  ram[0x3fa] = 0x85; frames(3); ram[0x3fa] = 0x84; frames(3);   // a shuriken thrown
  ram[0x3fb] = 3; frames(3); ram[0x3fb] = 2; frames(3);         // a smoke bomb used
  const before = unlocked.size;
  ram[HERE] = 0x9e; ram[0x3f7] = 1; frames(3);                   // mid-load: junk letter
  expect(unlocked.size === before && !has('The Sword'), 'a counter changing while a level loads is no pick-up');
  ok('using a weapon, or a level loading, unlocks nothing more');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - last-ninja set: ${testNo} checks`);
