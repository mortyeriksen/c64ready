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
  const order = [
    'The Sword', 'Nunchaku', 'Stepping Stones', 'Now You See Me', 'Throwing Stars',
    "Dragon's Breath", 'Into the Wilderness', 'Wastelands Survivor', 'Wastelands Sprint',
    'Cliffhanger', 'The Staff', 'Palace Gardens', 'Into the Dungeons', 'The Palace',
    'Inner Sanctum', 'Secret Passage', 'Hound Handler', 'The Final Duel',
    'The Sacred Scrolls', 'Iron Will',
  ];
  expect(set.achievements.length === order.length, 'all expected trophies are present');
  expect(set.achievements.every((a, i) => a.id === i + 1), 'IDs follow display order from 1 without gaps');
  expect(set.achievements.every((a, i) => a.title === order[i]), 'trophies follow the game route');
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
  expect([...Object.values(titles)].every((title) => has(title)), 'five level achievements');
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
  const weapons = [['The Sword', 0x3f7, 1], ['Nunchaku', 0x3f9, 1], ['Throwing Stars', 0x3fa, 0x85], ['Now You See Me', 0x3fb, 3]];
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

// 8. A clean Wastelands run starts when A loads. A lost life invalidates that attempt, including when
// an apple previously raised the count. Remaining in A after the loss must not start a new attempt.
{
  activate(); load('A'); ram[0x9b] = 3; frames(5); load('B');
  expect(has('Wastelands Survivor'), 'reaching B without losing a life unlocks the survivor trophy');

  activate(); load('A'); ram[0x9b] = 3; frames(5);
  ram[0x9b] = 4; frames(5); ram[0x9b] = 3; frames(5); load('B');
  expect(!has('Wastelands Survivor'), 'an extra life does not hide a later loss');

  activate(); load('A'); ram[0x9b] = 3; frames(5);
  ram[0x9b] = 2; frames(100); load('B');
  expect(!has('Wastelands Survivor'), 'a lost life cannot be cleared by waiting in level A');
  ok('Wastelands Survivor needs a full level without a lost life');
}

// 9. The five-minute timer starts on A's load transition and counts PAL frames, including time spent
// loading B. A timed-out attempt cannot restart halfway through A.
{
  activate(); ram[HERE] = 0x85; frames(10); load('A'); frames(14900); load('B');
  expect(has('Wastelands Sprint'), 'a level 1 run under five minutes unlocks');

  activate(); ram[HERE] = 0x85; frames(10); load('A'); frames(15010); load('B');
  expect(!has('Wastelands Sprint'), 'a level 1 run after five minutes does not unlock');

  activate(); ram[HERE] = 0x85; frames(10); load('A'); frames(15010);
  frames(100); load('B');
  expect(!has('Wastelands Sprint'), 'timeout cannot restart while still in level 1');
  ok('Wastelands Sprint has a five-minute limit from level start');
}

// 10. The final battle is on Inner Sanctum screen 14. Victory moves Armakuni to the separate scroll
// chamber, screen 15. Either room alone, or the same room numbers in another level, is insufficient.
{
  activate(); load('F'); ram[0xa2] = 15; frames(5);
  expect(!has('The Final Duel'), 'the scroll chamber alone does not unlock the duel');
  ram[0xa2] = 14; frames(5);
  expect(!has('The Final Duel'), 'the final opponent room alone does not unlock the duel');
  ram[0xa2] = 15; frames(5);
  expect(has('The Final Duel'), 'the final opponent room followed by the scroll chamber unlocks');

  activate(); load('A'); ram[0xa2] = 14; frames(5); ram[0xa2] = 15; frames(5);
  expect(!has('The Final Duel'), 'rooms 14 and 15 on another level do not unlock the duel');

  activate(); load('F'); ram[0xa2] = 14; frames(5); load('A'); load('F');
  ram[0xa2] = 15; frames(5);
  expect(!has('The Final Duel'), 'leaving the Inner Sanctum clears the final room checkpoint');
  ok('The Final Duel needs the Inner Sanctum victory transition');
}

// 11. The vase room is screen 10, the hound is screen 11, and the archer statue is screen 12.
// Screen 11 can be crossed without the bottle, so the hound trophy also needs its inventory use.
{
  activate(); load('F'); ram[0xa2] = 11; frames(5);
  expect(!has('Secret Passage'), 'arriving in the hound room alone is no passage unlock');
  ram[0xa2] = 12; frames(5);
  expect(!has('Hound Handler'), 'passing the hound without the bottle does not unlock');

  activate(); load('F'); ram[0xa2] = 10; frames(5);
  expect(!has('Secret Passage'), 'the vase room alone is no passage unlock');
  ram[0xa2] = 11; frames(5);
  expect(has('Secret Passage'), 'moving through the vase passage unlocks');
  expect(!has('Hound Handler'), 'entering the hound room does not clear it');
  ram[0x3ef] = 1; frames(5); ram[0x3ef] = 0; frames(5);
  ram[0xa2] = 12; frames(5);
  expect(has('Hound Handler'), 'using the bottle before passing the hound unlocks');

  activate(); load('F'); ram[0xa2] = 10; ram[0x3ef] = 1; frames(5);
  ram[0x3ef] = 0; frames(5); ram[0xa2] = 11; frames(5); ram[0xa2] = 12; frames(5);
  expect(!has('Hound Handler'), 'using the bottle before reaching the hound does not unlock');

  activate(); load('F'); ram[0xa2] = 11; ram[0x9b] = 3; ram[0x3ef] = 1; frames(5);
  ram[0x3ef] = 0; frames(5); ram[0x9b] = 2; frames(5); ram[0xa2] = 12; frames(5);
  expect(!has('Hound Handler'), 'losing a life after throwing the bottle cancels that attempt');

  activate(); load('A'); ram[0xa2] = 10; frames(5);
  ram[0x3ef] = 1; frames(5); ram[0x3ef] = 0; frames(5);
  ram[0xa2] = 11; frames(5); ram[0xa2] = 12; frames(5);
  expect(!has('Secret Passage') && !has('Hound Handler'), 'other levels do not award the sanctum route');
  ok('Secret Passage and Hound Handler follow the sanctum route');
}

// 12. The cartridge's $5963 pickup routine increments inventory item 9 at $03F5 and sets $77 to 9
// when the scrolls are taken. The final chamber is screen 15.
{
  activate(); load('F'); ram[0xa2] = 15; frames(5);
  expect(!has('The Sacred Scrolls'), 'visiting the scroll chamber alone does not unlock');
  ram[0x3f5] = 1; frames(5);
  expect(!has('The Sacred Scrolls'), 'an inventory change without the scroll pickup flag does not unlock');

  activate(); load('F'); ram[0xa2] = 15; frames(5);
  ram[0x77] = 9; ram[0x3f5] = 1; frames(5);
  expect(has('The Sacred Scrolls'), 'the scroll pickup in the chamber unlocks');

  activate(); load('A'); ram[0xa2] = 15; frames(5);
  ram[0x77] = 9; ram[0x3f5] = 1; frames(5);
  expect(!has('The Sacred Scrolls'), 'the pickup bytes on another level do not unlock');
  ok('The Sacred Scrolls requires the altar pickup');
}

// 13. The staff is item 12 on Wilderness screen 23. Its inventory byte follows the other weapons.
{
  activate(); load('B'); ram[0xa2] = 23; frames(5);
  expect(!has('The Staff'), 'the staff is locked before its pickup');
  ram[0x3f8] = 1; frames(5);
  expect(has('The Staff'), 'the staff inventory pickup unlocks');

  activate(); ram[HERE] = 0x85; frames(5); ram[0x3f8] = 1; frames(5);
  expect(!has('The Staff'), 'startup inventory junk is not a staff pickup');
  ok('The Staff follows the weapon pickup');
}

// 14. The Wilderness cliff leads from screen 4 to the upper ledge on screen 5. The claw is item 5.
{
  activate(); load('B'); ram[0xa2] = 4; frames(5); ram[0xa2] = 5; frames(5);
  expect(!has('Cliffhanger'), 'the ledge without the claw does not unlock');

  activate(); load('B'); ram[0x3f1] = 1; ram[0xa2] = 4; frames(5);
  ram[0xa2] = 5; frames(5);
  expect(has('Cliffhanger'), 'scaling the cliff with the claw unlocks');

  activate(); load('A'); ram[0x3f1] = 1; ram[0xa2] = 4; frames(5);
  ram[0xa2] = 5; frames(5);
  expect(!has('Cliffhanger'), 'the same room numbers on another level do not unlock');
  ok('Cliffhanger needs the claw and Wilderness climb');
}

// 15. The dragon guards Wastelands screen 20. A smoke bomb has a three-use inventory counter at $03FB.
{
  activate(); load('A'); ram[0x9b] = 3; ram[0x3fb] = 3; ram[0xa2] = 20; frames(5);
  ram[0x3fb] = 2; frames(5); load('B');
  expect(has("Dragon's Breath"), 'smoking the dragon then leaving the Wastelands unlocks');

  activate(); load('A'); ram[0x3fb] = 3; ram[0xa2] = 19; frames(5);
  ram[0x3fb] = 2; frames(5); load('B');
  expect(!has("Dragon's Breath"), 'using a smoke bomb before the dragon does not unlock');

  activate(); load('A'); ram[0x9b] = 3; ram[0x3fb] = 3; ram[0xa2] = 20; frames(5);
  ram[0x3fb] = 2; frames(5); ram[0x9b] = 2; frames(5); load('B');
  expect(!has("Dragon's Breath"), 'losing a life after smoking the dragon cancels the attempt');
  ok("Dragon's Breath needs the dragon room and completed escape");
}

// 16. Iron Will starts with the Wastelands and ends with the scroll pickup, with no lost life at any level.
{
  activate(); ram[HERE] = 0x85; frames(5); load('A'); ram[0x9b] = 3;
  for (const L of 'BCDEF') load(L);
  ram[0xa2] = 15; frames(5); ram[0x77] = 9; ram[0x3f5] = 1; frames(5);
  expect(has('Iron Will'), 'taking the scrolls after an unbroken run unlocks');

  activate(); ram[HERE] = 0x85; frames(5); load('A'); ram[0x9b] = 3;
  load('B'); ram[0x9b] = 4; frames(5); ram[0x9b] = 3; frames(5);
  for (const L of 'CDEF') load(L);
  ram[0xa2] = 15; frames(5); ram[0x77] = 9; ram[0x3f5] = 1; frames(5);
  expect(!has('Iron Will'), 'an extra life does not hide a life lost earlier');
  ok('Iron Will needs a life without loss through the whole game');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - last-ninja set: ${testNo} checks`);
