// Spec tests for the ported Action Biker achievement set
// (server/sets/action-biker.json, from c64-cheevos, MIT) under rcheevos, on
// synthesized RAM laid out as the set reads it: bikes left $076B (a screen
// code digit, "0" is $30), score $4AB1-$4AB3 (BCD, lowest pair first), the
// $1D counter (0 on the title, 6 once SPACE starts a game), the item count
// $4621 (items come in a fixed order, the 40th is the drag race ticket), fuel
// $4619 ($57 is a full large tank), speed $FB and the completion byte $01FE.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/action-biker.json'), 'utf8')), 'action-biker.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const BIKES = 0x076b, SCORE = 0x4ab1, COUNTER = 0x1d, ITEMS = 0x4621, FUEL = 0x4619, SPEED = 0xfb, DONE = 0x01fe;

function activateAll() {
  rc.clear();
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  const lb = set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
  return { codes, lb };
}
const unlocked = new Set();
const lbEvents = [];
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) lbEvents.push({ ...e });
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
/** The title (5 bikes, counter 0), then SPACE: the counter jumps to 6. */
function fresh() {
  activateAll(); unlocked.clear(); lbEvents.length = 0; ram.fill(0);
  ram[BIKES] = 0x35; ram[FUEL] = 0x3b; frames(10);
  ram[COUNTER] = 6; frames(5);
}
const has = (t) => unlocked.has(id[t]);
const collect = (n) => { ram[ITEMS] = n; frames(2); };

// 1. Every condition and the leaderboard parse, and the local cartridge is the listed file.
{
  const { codes, lb } = activateAll();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(lb.every((c) => c === 0), 'the high-score leaderboard parses');
  expect(set.achievements.length === 41, 'all 41 c64cade achievements are in the set');
  ok(`all ${codes.length} achievements and ${lb.length} leaderboard parse`);
  const file = assetPath('action-biker-crt');
  if (!file) console.log(`ok  - the local cartridge hashes to the listed file # SKIP ${missingNote('action-biker-crt')}`);
  else {
    const hash = rc.hash(fs.readFileSync(file));
    expect(set.hashes.some((h) => h.hash === hash), `the OneLoad64 cartridge's hash ${hash} is listed`);
    ok('the local cartridge hashes to the listed file');
  }
}

// 2. The intro (bikes a blank $20, score bytes 00 FF FF) and the title.
{
  activateAll(); unlocked.clear(); lbEvents.length = 0; ram.fill(0);
  ram[BIKES] = 0x20; ram.set([0x00, 0xff, 0xff], SCORE); ram[DONE] = 0xa5; frames(60);
  ram[BIKES] = 0x35; ram.fill(0, SCORE, SCORE + 3); ram[DONE] = 0xd8; frames(120);
  expect(unlocked.size === 0, `nothing unlocks on the intro or title (got ${[...unlocked]})`);
  expect(!lbEvents.length, 'no leaderboard attempt before SPACE');
  ok('nothing unlocks before a game');
}

// 3. Each item, in the game's fixed order (ActionBiker.js), unlocks its own
// achievement and no other. Gas Guzzler (8), Need For Speed (12) and the
// drag race (40) have extra rules, tested below.
const ITEM_ORDER = [
  'Don\'t Ride Without One', 'Hell for Leathers', 'Passed Your Theory', 'Metal Gear', 'Kid Gloves',
  'Night Rider', 'Running on Empty', null, 'All Tooled Up', 'Mud in Your Eye', "I'll Be Back", null,
  'Thirsty Work', 'Hyper Visor', 'High Emission Zone', 'Where Are the Brakes?', 'Speedos',
  'Master of the Lamps', 'Jamie Olive Oil', 'Turbo Charged!', 'Only Fins', 'You\'ve Got Them, Use Them!',
  'Mirror, Signal, Manoeuvre', 'Tommy Tutone', 'Raise Reflectors!', 'A to Z', 'Twisted Electric Starter',
  'Packed the Skips!', '10-4, Good Buddy', 'White Stripes', 'Ski Sunday', 'Safety First', 'Light Fog',
  'Speedrunner', 'Kickstart', 'Guns n\' Roses', 'Gin and Tonic', 'Revs', 'Didn\'t We Have One Already?',
  'No Ticket, No Race',
];
{
  fresh();
  for (let n = 1; n <= 40; n++) {
    const t = ITEM_ORDER[n - 1];
    if (t) expect(id[t] && !has(t), `${t} is in the set and not unlocked before item ${n}`);
    const before = new Set(unlocked);
    collect(n);
    if (t) expect(has(t), `${t} on item ${n}`);
    const extra = [...unlocked].filter((x) => !before.has(x) && x !== id[t]);
    expect(!extra.length, `item ${n} unlocks nothing else (got ${extra})`);
  }
  ok('the item achievements follow the item count');
}

// 4. Gas Guzzler: the large fuel tank (item 8) filled to $57.
{
  fresh();
  collect(8); ram[FUEL] = 0x56; frames(2);
  expect(!has('Gas Guzzler'), 'not before the tank is full');
  ram[FUEL] = 0x57; frames(2);
  expect(has('Gas Guzzler'), 'Gas Guzzler with item 8 and fuel $57');
  ok('Gas Guzzler');
}

// 5. Need For Speed: the fairing (item 12) and full speed ($FB = $0B).
{
  fresh();
  collect(11); ram[SPEED] = 0x0b; frames(2);
  expect(!has('Need for Speed'), 'full speed before the fairing is not it');
  collect(12); frames(2);
  expect(has('Need for Speed'), 'Need For Speed at full speed with the fairing');
  ok('Need for Speed');
}

// 6. No Second Prize: all 40 items and the completion byte $37.
{
  fresh();
  collect(40); frames(2);
  expect(!has('No Second Prize'), 'not on the ticket alone');
  ram[DONE] = 0x37; frames(2);
  expect(has('No Second Prize'), 'No Second Prize when the race is won');
  ok('No Second Prize');
}

// 7. A new game zeroes the item count: nothing fires on the way down.
{
  fresh();
  collect(1); collect(2); collect(3);
  const before = unlocked.size;
  ram[BIKES] = 0x30; frames(5);
  ram[BIKES] = 0x35; ram[ITEMS] = 0; frames(5);
  expect(unlocked.size === before, 'resetting the count unlocks nothing');
  ok('a new game');
}

// 8. Leaderboard: SPACE starts it, the last bike submits the BCD score.
{
  fresh();
  expect(lbEvents.some((e) => e.type === EVENT.LBOARD_STARTED), 'the counter going 0 to 6 with 5 bikes starts the attempt');
  ram.set([0x21, 0x13, 0x01], SCORE); frames(2);
  for (let b = 0x34; b >= 0x30; b--) { ram[BIKES] = b; ram[COUNTER] = 3; frames(3); }
  expect(!lbEvents.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'no submit while the counter runs');
  ram[COUNTER] = 0; frames(1);
  const sub = lbEvents.find((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(sub && sub.value === 11321, `game over submits 011321 as 11321 (got ${sub?.value})`);
  ok('the high-score leaderboard');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - action-biker set: ${testNo} checks`);
