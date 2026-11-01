// Spec tests for the Super Mario Bros 64 achievement set (server/sets/super-mario-bros-64.json,
// ZeroPaige's 2019 port on the OneLoad64 v5 cartridge) under rcheevos, on synthesized RAM laid out
// as the port keeps it, which is the NES game's RAM map:
//   $0770 OperMode: 0 title and demo, 1 playing, 2 the victory after 8-4, 3 game over.
//   $077A players: 0 for one player. $075A lives (2 at the start: three Marios).
//   $075F world 0-7, $075C level 0-3 within it. A flagpole steps the level; a castle sets the
//         level to 0 and steps the world; a warp pipe sets a later world with level 0.
//   $075E coins: 100 wraps to 0 and adds a life.
//   $0756 power: 0 small, 1 big, 2 fire. $0E the engine routine, 4 while sliding down the
//         flagpole, with $010F the flagpole score set just before (4 = 5,000 at the top).
//   $07DD-$07E2 the score's six digits (0-9 each); the shown score has a 0 after them.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/super-mario-bros-64.json'), 'utf8')), 'super-mario-bros-64.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = '1c08be698922fdd0505d9d84ff4b63f6';
const MODE = 0x770, PLAYERS = 0x77a, LIVES = 0x75a, WORLD = 0x75f, LEVEL = 0x75c, COINS = 0x75e, POWER = 0x756, ENGINE = 0x0e, POLE = 0x10f, SCORE = 0x7dd;

/** The shown score: six digit bytes holding shown / 10. */
function setScore(shown) { const d = String(shown / 10).padStart(6, '0'); for (let i = 0; i < 6; i++) ram[SCORE + i] = Number(d[i]); }
const unlocked = new Set();
const lb = [];
function activate() {
  rc.clear(); unlocked.clear(); lb.length = 0; ram.fill(0);
  return {
    codes: set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr)),
    boards: set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition)),
  };
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED && e.type !== EVENT.LBOARD_UPDATED) lb.push({ ...e });
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const started = () => lb.filter((e) => e.type === EVENT.LBOARD_STARTED).length;
const submitted = () => lb.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
const has = (title) => unlocked.has(id[title]);

/** The title and its demo: the demo plays 1-1 in OperMode 0, collecting coins and points. */
function title(players = 0) {
  ram[MODE] = 0; ram[PLAYERS] = players; ram[LIVES] = 2; frames(5);
  ram[COINS] = 99; frames(2); ram[COINS] = 0; ram[LIVES] = 3; ram[POWER] = 2; setScore(300000); frames(3);
  ram[LEVEL] = 1; ram[ENGINE] = 4; ram[POLE] = 4; frames(3);
  ram[WORLD] = 0; ram[LEVEL] = 0; ram[LIVES] = 2; ram[POWER] = 0; ram[ENGINE] = 0; ram[POLE] = 0; setScore(0); frames(5);
}
/** A game starts from the title at a world (0 for a new game, later for a continue). */
function start(world = 0) { ram[WORLD] = world; ram[LEVEL] = 0; ram[COINS] = 0; setScore(0); ram[LIVES] = 2; ram[MODE] = 1; frames(10); }
/** The flagpole: the score index is set, the slide begins, then the next level. */
function flagpole(top = false) { ram[POLE] = top ? 4 : 1; ram[ENGINE] = 4; frames(20); ram[ENGINE] = 8; ram[LEVEL]++; frames(10); }
/** A castle: the level goes to 0 and the world steps on (via level 4 if a frame falls between). */
function castle(splitFrame = false) {
  if (splitFrame) { ram[LEVEL] = 4; frames(1); }
  ram[LEVEL] = 0; ram[WORLD]++; frames(10);
}
function gameOver() { ram[MODE] = 3; frames(20); ram[MODE] = 0; frames(10); }

// 1. Every condition and the leaderboard parse, and the set names the cartridge.
{
  const { codes, boards } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.length === 1 && boards[0] === 0, 'the high-score leaderboard parses');
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  expect(set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'High Score is a SCORE board, higher is better');
  ok(`all ${codes.length} achievements and ${boards.length} leaderboard parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('super-mario-bros-64-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'super-mario-bros-64-crt is not registered in test/external-assets.json';
    try { note = missingNote('super-mario-bros-64-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the OneLoad64 cartridge hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the OneLoad64 cartridge hashes to the listed hash'); }
}

// 3. The title and its demo unlock nothing.
{
  activate(); title(); title();
  expect(unlocked.size === 0 && started() === 0, `the demo counts for nothing (got ${[...unlocked]})`);
  ok('the title demo is not a game');
}

// 4. Two-player games count for nothing, even after a one-player game.
{
  activate(); title(1); start(); flagpole(true); ram[COINS] = 99; frames(2); ram[COINS] = 0; ram[LIVES] = 3; frames(2); setScore(300000); frames(2); gameOver();
  expect(unlocked.size === 0 && started() === 0, `a two-player game counts for nothing (got ${[...unlocked]})`);
  activate(); title(); start(); setScore(500); frames(2); gameOver();
  title(1); start(); flagpole(true); frames(2);
  expect(unlocked.size === 0, `an earlier one-player game does not open a two-player one (got ${[...unlocked]})`);
  ok('two players are kept out');
}

// 5. 1-1 and every castle, then the princess.
{
  activate(); title(); start();
  flagpole();
  expect(has('First Steps'), 'First Steps when 1-1 ends');
  flagpole(); flagpole();
  expect(!has('World 1 Cleared'), 'not before the castle');
  castle(true);
  expect(has('World 1 Cleared'), 'World 1 Cleared when the castle steps the world (with a frame at level 4)');
  for (let w = 2; w <= 7; w++) {
    flagpole(); flagpole(); flagpole(); castle();
    expect(has(`World ${w} Cleared`), `World ${w} Cleared`);
  }
  expect(ram[WORLD] === 7 && !has('Princess Rescued'), 'in World 8, the princess is still waiting');
  flagpole(); flagpole(); flagpole();
  ram[MODE] = 2; frames(5);
  expect(has('Princess Rescued'), 'Princess Rescued when 8-4 ends in the victory');
  expect(!has('Warp Pipe'), 'no warp was taken');
  ok('levels, castles and the princess');
}

// 6. A warp pipe: a later world from level 2, not a castle.
{
  activate(); title(); start(); flagpole();
  ram[WORLD] = 3; ram[LEVEL] = 0; frames(5);
  expect(has('Warp Pipe') && !has('World 1 Cleared'), 'Warp Pipe from 1-2 to 4-1, which is no castle clear');
  ok('warp pipe');
}

// 7. A continue from the title starts a game in a later world; the start is no warp or castle.
{
  activate(); title(); start(4);
  expect(unlocked.size === 0 && started() === 1, `a continue in World 5 unlocks nothing and starts an attempt (got ${[...unlocked]})`);
  ok('continues');
}

// 8. Lives, coins, fire and the flagpole top.
{
  activate(); title(); start();
  ram[LIVES] = 3; frames(2);
  expect(has('One Up'), 'One Up for a life gained');
  for (let c = 1; c <= 99; c++) { ram[COINS] = c; frame(); }
  expect(!has('Coin Collector'), '99 coins are not 100');
  ram[COINS] = 0; ram[LIVES] = 4; frames(2);
  expect(has('Coin Collector'), 'Coin Collector at the hundredth coin');
  ram[POWER] = 1; frames(2);
  expect(!has('Fire Power'), 'a mushroom is not a fire flower');
  ram[POWER] = 2; frames(2);
  expect(has('Fire Power'), 'Fire Power');
  flagpole();
  expect(!has('Top of the Pole'), 'a low grab is not the top');
  flagpole(true);
  expect(has('Top of the Pole'), 'Top of the Pole for the 5,000-point grab');
  ok('one up, coins, fire and the flagpole');
}

// 9. A life lost and the next game's lives are not a one-up.
{
  activate(); title(); start(); ram[LIVES] = 1; frames(2);
  gameOver(); title(); start();
  expect(!has('One Up'), 'a new game\'s lives are not an extra life');
  ok('one up needs play');
}

// 10. Score tiers, in tens.
{
  activate(); title(); start();
  for (const [t, pts] of [['Score 50,000', 50000], ['Score 100,000', 100000], ['Score 250,000', 250000]]) {
    setScore(pts - 50); frames(2);
    expect(!has(t), `${t}: ${pts - 50} is short`);
    setScore(pts); frames(2);
    expect(has(t), `${t} at ${pts}`);
  }
  ok('score tiers');
}

// 11. High Score: submitted at game over with the shown score.
{
  activate(); title(); start();
  expect(started() === 1, 'a one-player game starts the attempt');
  setScore(12340); frames(5);
  expect(!submitted().length, 'nothing is submitted in play');
  gameOver();
  const s = submitted();
  expect(s.length === 1 && s[0].value === 12340, `game over submits 12,340 (got ${s.map((e) => e.value)})`);
  title();
  expect(submitted().length === 1, 'the title and demo submit nothing more');
  start();
  expect(started() === 2, 'the next game starts a new attempt');

  activate(); title(); start(); gameOver();
  expect(started() === 1 && !submitted().length, 'a pointless game submits nothing');
  ok('High Score start, submit and value');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - super-mario-bros-64 set: ${testNo} checks`);
