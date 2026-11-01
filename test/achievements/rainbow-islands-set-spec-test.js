// Spec tests for the ported Rainbow Islands achievement set
// (server/sets/rainbow-islands.json, from c64-cheevos, MIT) under rcheevos, on
// synthesized RAM laid out as the set reads it: score $115B-$115E (BCD, highest
// pair first), lives $1160 (0 is the last life, $FF game over), island $1165
// and round $1166 (0-based), diamond order $AD (counts down from 6) and
// mistakes $AE, active and permanent power-ups $4E/$4F, the shilver door $A8,
// the final room's coin $0A34 and round-end flag $26, and the ending markers
// $06F8/$06F9.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/rainbow-islands.json'), 'utf8')), 'rainbow-islands.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const SCORE = 0x115b, LIVES = 0x1160, ISLAND = 0x1165, ROUND = 0x1166, DIA = 0xad, MISTAKES = 0xae;
const ACTIVE = 0x4e, PERM = 0x4f, DOOR = 0xa8, COIN = 0x0a34, ROUND_END = 0x26, ENDING = 0x06f8;
const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);

function setScore(n) {
  for (let i = 3; i >= 0; i--) { ram[SCORE + i] = bcd(n % 100); n = Math.floor(n / 100); }
}
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
/** Title screen (lives 0, island 0), then a new game: lives 2, round 0. */
function fresh() {
  activateAll(); unlocked.clear(); lbEvents.length = 0; ram.fill(0);
  frames(10);
  ram[LIVES] = 2; ram[DIA] = 6; frames(5);
}
const has = (t) => unlocked.has(id[t]);

// 1. Every condition and the leaderboard parse, and the local cartridge is the listed file.
{
  const { codes, lb } = activateAll();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(lb.every((c) => c === 0), 'the high-score leaderboard parses');
  expect(set.achievements.length === 24, 'all 24 c64cade achievements are in the set');
  ok(`all ${codes.length} achievements and ${lb.length} leaderboard parse`);
  const file = assetPath('rainbow-islands-crt');
  if (!file) console.log(`ok  - the local cartridge hashes to a listed file # SKIP ${missingNote('rainbow-islands-crt')}`);
  else {
    const hash = rc.hash(fs.readFileSync(file));
    expect(set.hashes.some((h) => h.hash === hash), `the OneLoad64 cartridge's hash ${hash} is listed`);
    ok('the local cartridge hashes to a listed file');
  }
}

// 2. Loading and the title screen: the loader leaves junk in the game's bytes
// (score $7D98C7AA, lives $94, island $BD), then the title holds lives 0.
{
  activateAll(); unlocked.clear(); lbEvents.length = 0; ram.fill(0);
  ram.set([0x7d, 0x98, 0xc7, 0xaa], SCORE); ram[LIVES] = 0x94; ram[ISLAND] = 0xbd; ram[ROUND] = 0xf3;
  frames(60);
  ram.fill(0, SCORE, SCORE + 4); ram[LIVES] = 0; ram[ISLAND] = 0; ram[ROUND] = 0;
  frames(120);
  expect(unlocked.size === 0, `nothing unlocks while loading or on the title (got ${[...unlocked]})`);
  expect(!lbEvents.length, 'no leaderboard attempt starts before a game');
  ok('nothing unlocks before a game');
}

// 3. Score: 250,000, 500,000 and a million, BCD with the highest pair first.
{
  fresh();
  setScore(249990); frames(2);
  expect(!has('Pot of Gold'), '249,990 is short of 250,000');
  setScore(250000); frames(2);
  expect(has('Pot of Gold'), 'Pot of Gold at 250,000');
  setScore(500000); frames(2);
  expect(has('Big Food'), 'Big Food at 500,000');
  expect(!has('Big Whoop'), 'not Big Whoop at 500,000');
  setScore(1000000); frames(2);
  expect(has('Big Whoop'), 'Big Whoop at 1,000,000');
  ok('score tiers');
}

// 4. The completion screen fills the score bytes with junk: no score unlocks there.
{
  fresh();
  setScore(18060); ram[ISLAND] = 6; frames(3);
  ram.set([0x9e, 0x14, 0xbd, 0xa1], SCORE); ram[ISLAND] = 0xa1; ram[ROUND] = 0x14; ram[LIVES] = 0x49; frames(3);
  expect(!has('Big Whoop') && !has('Pot of Gold'), 'the completion screen\'s junk score unlocks no score tier');
  const sub = lbEvents.find((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(sub && sub.value === 18060, `completing the game submits the score from before the junk (got ${sub?.value})`);
  ok('the completion screen submits the real score');
}

// 5. Islands: clearing island N moves the island index from N-1 to N.
{
  fresh();
  const titles = ['Bug Spray', 'Helikopter Helikopter', 'Do the Mash', 'Toy Story', 'Revenge on DOH!', "The Droids You're Looking For?"];
  for (let n = 1; n <= 6; n++) {
    expect(!has(titles[n - 1]), `${titles[n - 1]} not before island ${n} is cleared`);
    ram[ISLAND] = n; ram[ROUND] = 0; frames(2);
    expect(has(titles[n - 1]), `${titles[n - 1]} when island ${n} is cleared`);
  }
  expect(!has('End of the Rainbow!'), 'not End of the Rainbow on Dragon Island itself');
  ram[ISLAND] = 7; frames(2);
  expect(has('End of the Rainbow!'), 'End of the Rainbow when Dragon Island is cleared');
  expect(has('The 1CC!'), 'The 1CC when the game is beaten without a game over');
  ok('island clears and the end of the game');
}

// 6. A warp through the shilver door to Dragon Island clears no island on the way.
{
  fresh();
  ram[ISLAND] = 2; frames(2);
  ram[ROUND] = 19; ram[DOOR] = 5; frames(2);
  expect(has('Shilver Door'), 'Shilver Door at round 19 with $A8 = 5');
  ram[ISLAND] = 6; ram[ROUND] = 24; frames(2);
  expect(!has("The Droids You're Looking For?"), 'warping to Dragon Island does not clear Robot Island');
  ok('the shilver door');
}

// 7. The 1CC: a game over in the run spoils it; the next new game starts clean.
{
  fresh();
  ram[ISLAND] = 3; frames(2);
  ram[LIVES] = 0; frames(2); ram[LIVES] = 0xff; frames(10);
  // Fire restarts from island 0 round 0, straight from the game over.
  ram[ISLAND] = 0; ram[ROUND] = 0; ram[LIVES] = 2; frames(2);
  ram[ISLAND] = 6; frames(2);
  ram[ISLAND] = 7; frames(2);
  expect(has('End of the Rainbow!'), 'beating the game still counts as End of the Rainbow');
  expect(has('The 1CC!'), 'a game over before the new game does not spoil the 1CC of the next game');
  fresh();
  ram[ISLAND] = 6; frames(2);
  ram[LIVES] = 0; frames(2); ram[LIVES] = 0xff; frames(2);
  ram[LIVES] = 1; frames(2);
  ram[ISLAND] = 0xa1; frames(2);
  expect(!has('The 1CC!'), 'no 1CC after a game over in the same run');
  ok('the 1CC');
}

// 8. Permanent upgrades, one bit each of $4F.
{
  fresh();
  const bits = [['Need For Speed', 0x40], ['Red Potion Mastery', 0x01], ['Yellow Potion Mastery', 0x04], ['Redbull', 0x80], ['Birds of a Feather', 0x10]];
  for (const [t, bit] of bits) {
    expect(!has(t), `${t} not before its bit`);
    ram[PERM] |= bit; frames(2);
    expect(has(t), `${t} at $4F bit $${bit.toString(16)}`);
  }
  ok('permanent upgrades');
}

// 9. Red Potion Mastery reads bit 0 only: triple rainbows alone ($02) is not it.
{
  fresh();
  ram[PERM] = 0x02; frames(3);
  expect(!has('Red Potion Mastery'), 'not at $4F = $02');
  ok('Red Potion Mastery is the double-rainbows bit');
}

// 10. Upgrade counts: permanent bits, the shilver door and the final coin.
{
  fresh();
  ram[PERM] = 0x40; frames(2);
  expect(!has('Rainbow Veteran'), 'one upgrade is not two');
  ram[PERM] = 0x41; frames(2);
  expect(has('Rainbow Veteran'), 'Rainbow Veteran at two permanent upgrades');
  ram[ROUND] = 19; ram[DOOR] = 5; frames(2);
  ram[DOOR] = 0; ram[ROUND] = 20; frames(2);
  expect(has('Rainbow Elite'), 'Rainbow Elite with the shilver door as the third');
  expect(!has('Rainbow Ultimate Master'), 'not Ultimate Master at three');
  ram[COIN] = 0x3d; ram[ROUND_END] = 0x1a; frames(2);
  expect(!has('Coin Op'), 'not Coin Op while the coin is still there');
  ram[COIN] = 0; frames(2);
  expect(has('Coin Op'), 'Coin Op when the final room\'s coin is collected');
  expect(has('Rainbow Ultimate Master'), 'Rainbow Ultimate Master with the coin as the fourth');
  ok('upgrade counts and Coin Op');
}

// 11. Coin Op needs the coin to have been present in the final boss room.
{
  fresh();
  ram[COIN] = 0x3d; ram[ROUND_END] = 0x1c; frames(2);
  ram[COIN] = 0; frames(2);
  expect(!has('Coin Op'), 'a coin flag drop outside the final boss room is not Coin Op');
  ok('Coin Op only in the final boss room');
}

// 12. Good Ending: the end screen with both markers at $0C.
{
  fresh();
  ram[ISLAND] = 0xa1; ram[ROUND] = 0x14; ram[ENDING] = 0x0f; ram[ENDING + 1] = 0x0f; frames(2);
  expect(!has('Good Ending'), 'the bad ending ($0F) is not the good one');
  ram[ENDING] = 0x0c; ram[ENDING + 1] = 0x0c; frames(2);
  expect(has('Good Ending'), 'Good Ending with both markers $0C');
  ok('Good Ending');
}

// 13. Perfect Collection: the last diamond in order on island 1 with no mistakes.
{
  fresh();
  for (let d = 5; d >= 1; d--) { ram[DIA] = d; frames(2); }
  expect(!has('Perfect Collection'), 'not before the last diamond');
  ram[DIA] = 0; frames(2);
  expect(has('Perfect Collection'), 'Perfect Collection when $AD reaches 0 without a mistake');
  fresh();
  ram[MISTAKES] = 1; for (let d = 5; d >= 0; d--) { ram[DIA] = d; frames(2); }
  expect(!has('Perfect Collection'), 'not with a mistake');
  ok('Perfect Collection');
}

// 14. Wings of Death: losing a life (or the last one) while holding wings.
{
  fresh();
  ram[LIVES] = 1; frames(2);
  expect(!has('Wings of Death'), 'losing a life without wings is not it');
  ram[ACTIVE] = 0x80; frames(2);
  ram[LIVES] = 0; ram[ACTIVE] = 0; frames(2);
  expect(has('Wings of Death'), 'Wings of Death when a life goes with wings held the frame before');
  fresh();
  ram[LIVES] = 0; ram[PERM] = 0x80; frames(2);
  ram[LIVES] = 0xff; frames(2);
  expect(has('Wings of Death'), 'and for the last life, with permanent wings');
  ok('Wings of Death');
}

// 15. Leaderboard: starts on a new game, submits at game over, restarts on fire.
{
  fresh();
  expect(lbEvents.some((e) => e.type === EVENT.LBOARD_STARTED), 'lives 0 to 2 on island 0 starts the attempt');
  setScore(50510); frames(3);
  ram[LIVES] = 0; frames(2); ram[LIVES] = 0xff; frames(1);
  const sub = lbEvents.find((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(sub && sub.value === 50510, `game over submits the score (got ${sub?.value})`);
  lbEvents.length = 0;
  ram[ROUND] = 2; frames(10);
  ram[ROUND] = 0; setScore(0); ram[LIVES] = 2; frames(2);
  expect(lbEvents.some((e) => e.type === EVENT.LBOARD_STARTED), 'a new game straight from the game over ($FF to 2) starts the next attempt');
  ok('the high-score leaderboard');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - rainbow-islands set: ${testNo} checks`);
