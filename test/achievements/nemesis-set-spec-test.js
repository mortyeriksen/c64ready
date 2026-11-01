// Spec tests for the Nemesis achievement set (server/sets/nemesis.json, the Konami 1987 C64
// conversion of Gradius on the OneLoad64 v5 cartridge) under rcheevos, on synthesized RAM laid
// out as the game keeps it:
//   $16D3 number of players, picked with SPACE on the title (1 is a one-player game).
//   $0258 player 1's lives between turns: 0 on the title, 3 when a game (or a continue) starts,
//         one less after each life; a game ends when it reaches 0. $0200-$0209 is player 1's
//         stored score, cleared when a game starts.
//   $5F98 lives of the player in play. $4000-$4009 the score in play, one decimal digit per byte
//         (scoring counts hundreds at $4007; $4008/$4009 stay 0).
//   $4C49 stage index 0-7 (8 wraps to 0). It reads 1 on the title and 5 for one frame at each
//         death while the game draws. $6ED3 rises when a stage is cleared, in the same frame the
//         index steps on.
//   Power-ups, reset at each life: speed $4CE8 (1-4), missile $50D9, double $50DA, laser $50DB
//   (double and laser exclude each other), multiples $5404 (1 plus the number, up to 3), shield
//   $52E6 (4 hits, 0 when gone).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/nemesis.json'), 'utf8')), 'nemesis.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = 'a14218cf0a4457320f4bad2c00db05b8';
const PLAYERS = 0x16d3, P1LIVES = 0x258, P1SCORE = 0x200, LIVES = 0x5f98, SCORE = 0x4000, STAGE = 0x4c49, CLEARED = 0x6ed3;
const SPEED = 0x4ce8, MISSILE = 0x50d9, DOUBLE = 0x50da, LASER = 0x50db, MULTI = 0x5404, SHIELD = 0x52e6;

/** The score in play: ten digit bytes. */
function setScore(n) { const d = String(n).padStart(10, '0'); for (let i = 0; i < 10; i++) ram[SCORE + i] = Number(d[i]); }
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

function title(players = 1) { ram[PLAYERS] = players; ram[P1LIVES] = 0; ram[STAGE] = 1; ram[CLEARED] = 0; lifeStart(); frames(10); }
/** A life starting: the power-ups reset. */
function lifeStart() { ram[SPEED] = 1; ram[MISSILE] = 0; ram[DOUBLE] = 0; ram[LASER] = 0; ram[MULTI] = 1; ram[SHIELD] = 0; }
/** A new game: player 1's lives and stored score set, then copied into play at stage 0. */
function newGame() {
  for (let i = 0; i < 10; i++) ram[P1SCORE + i] = 0;
  ram[P1LIVES] = 3; frames(1);
  ram[LIVES] = 3; setScore(0); ram[STAGE] = 0; lifeStart(); frames(30);
}
/** Clearing the stage in play: the flag rises as the index steps on (7 wraps to 0). */
function clearStage() { ram[CLEARED] = 1; ram[STAGE] = (ram[STAGE] + 1) % 8; frames(3); ram[CLEARED] = 0; frames(30); }
/** A death: the stage index flashes 5 for a frame as a life goes, then the next life starts. */
function die() {
  const stage = ram[STAGE];
  ram[STAGE] = 5; frames(1);
  ram[STAGE] = stage; ram[LIVES]--; ram[P1LIVES] = ram[LIVES]; frames(1);
  if (ram[P1LIVES]) { lifeStart(); frames(30); }
}
function gameOver() { while (ram[P1LIVES] > 0) die(); ram[STAGE] = 1; frames(30); }

// 1. Every condition and the leaderboard parse, and the set names the cartridge.
{
  const { codes, boards } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.length === 1 && boards[0] === 0, 'the high-score leaderboard parses');
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names Nemesis.crt');
  expect(set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'High Score is a SCORE board, higher is better');
  ok(`all ${codes.length} achievements and ${boards.length} leaderboard parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('nemesis-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'nemesis-crt is not registered in test/external-assets.json';
    try { note = missingNote('nemesis-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the OneLoad64 cartridge hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the OneLoad64 cartridge hashes to the listed hash'); }
}

// 3. Power-on junk and the title: power-up bytes, the clear flag and the score moving unlock nothing.
{
  activate();
  // As the cartridge loads: players $FF, the clear flag $80, then the title's values arrive.
  ram[PLAYERS] = 0xff; ram[CLEARED] = 0x80; setScore(9999999); frames(3);
  ram[PLAYERS] = 1; frames(2); ram[SPEED] = 1; frames(2); ram[LIVES] = 1; ram[STAGE] = 1; frames(2);
  ram[CLEARED] = 0; frames(2); ram[STAGE] = 5; frames(1); ram[STAGE] = 1; frames(2);
  ram[SPEED] = 4; ram[MISSILE] = 1; ram[LASER] = 1; ram[MULTI] = 3; ram[SHIELD] = 4; frames(3);
  ram[CLEARED] = 1; ram[STAGE] = 2; frames(3);
  title(); frames(30);
  expect(unlocked.size === 0 && started() === 0, `nothing before a game (got ${[...unlocked]})`);
  ok('power-on and the title unlock nothing');
}

// 4. Two-player games count for nothing.
{
  activate(); title(2); newGame();
  ram[MISSILE] = 1; ram[SPEED] = 2; frames(2); setScore(300000); clearStage(); frames(2);
  gameOver();
  expect(unlocked.size === 0, `a two-player game unlocks nothing (got ${[...unlocked]})`);
  expect(started() === 0 && !submitted().length, 'and is not on the leaderboard');

  activate(); title(); newGame(); setScore(1000); frames(2); gameOver();
  title(2); newGame(); ram[MISSILE] = 1; frames(2); setScore(60000); frames(2);
  expect(!has('Missile Away') && !has('Squadron Leader'), 'an earlier one-player game does not open a later two-player one');
  ok('two players are kept out');
}

// 5. Stage clears 1 to 8, by the stage the flag rose on.
{
  activate(); title(); newGame();
  const names = ['First Sortie', 'Second Wave', 'Third Front', 'Halfway Home', 'Deep Space', 'Into the Cells', 'Final Approach', 'Nemesis Defeated'];
  names.forEach((t, i) => {
    expect(!has(t), `${t} not before stage ${i + 1} is cleared`);
    clearStage();
    expect(has(t), `${t} when stage ${i + 1} is cleared`);
  });
  expect(ram[STAGE] === 0, 'stage 8 wraps to stage 1');
  ok('stages 1 to 8');
}

// 6. The death frame's stage 5 is not a clear.
{
  activate(); title(); newGame(); ram[STAGE] = 4; frames(2);
  die();
  expect(!has('Deep Space'), 'stage 5 drawn at a death on stage 5 is no clear');
  ok('deaths are not stage clears');
}

// 7. Clean Sweep: stage 1 of a new game without losing a life.
{
  activate(); title(); newGame(); clearStage();
  expect(has('Clean Sweep'), 'Clean Sweep for a deathless stage 1');

  activate(); title(); newGame(); die(); clearStage();
  expect(has('First Sortie') && !has('Clean Sweep'), 'a death rules it out');

  activate(); title(); newGame(); die(); gameOver(); newGame(); clearStage();
  expect(has('Clean Sweep'), 'the next game gets a fresh chance');
  ok('Clean Sweep');
}

// 8. Power-ups bought from the meter.
{
  activate(); title(); newGame();
  ram[SPEED] = 2; frames(2);
  expect(has('Speed Up') && !has('Full Throttle'), 'Speed Up at the first speed up');
  ram[SPEED] = 3; frames(2); ram[SPEED] = 4; frames(2);
  expect(has('Full Throttle'), 'Full Throttle at speed 4');
  ram[MISSILE] = 1; frames(2);
  expect(has('Missile Away'), 'Missile Away');
  ram[DOUBLE] = 1; frames(2);
  expect(has('Double Trouble'), 'Double Trouble');
  ram[DOUBLE] = 0; ram[LASER] = 1; frames(2);
  expect(has('Laser Focus'), 'Laser Focus');
  ram[MULTI] = 2; frames(2);
  expect(has('Multiple Choice') && !has('Twin Multiples'), 'Multiple Choice at one multiple');
  ram[MULTI] = 3; frames(2);
  expect(has('Twin Multiples'), 'Twin Multiples at two');
  expect(!has('Fully Loaded'), 'not fully loaded without the shield');
  ram[SHIELD] = 4; frames(2);
  expect(has('Force Field') && has('Fully Loaded'), 'Force Field, and Fully Loaded with all four');
  ok('power-ups');
}

// 9. The power-up reset at a new life, and the next life's base values, are not purchases.
{
  activate(); title(); newGame(); ram[SPEED] = 2; frames(2); unlocked.clear();
  activate(); title(); newGame();
  ram[SHIELD] = 3; frames(2); ram[SHIELD] = 2; frames(2);
  expect(!has('Force Field'), 'the shield wearing down is no purchase');
  die();
  expect(unlocked.size === 0, `a new life's reset unlocks nothing (got ${[...unlocked]})`);
  ok('resets are not purchases');
}

// 10. Score tiers, counted in hundreds.
{
  activate(); title(); newGame();
  for (const [t, pts] of [['Ace Pilot', 20000], ['Squadron Leader', 50000], ['Wing Commander', 100000], ['Hero of Gradius', 250000]]) {
    setScore(pts - 100); frames(2);
    expect(!has(t), `${t}: ${pts - 100} is short of ${pts}`);
    setScore(pts); frames(2);
    expect(has(t), `${t} at ${pts}`);
  }
  ok('score tiers at 20,000, 50,000, 100,000 and 250,000');
}

// 11. High Score: one attempt per game, submitted when player 1's last life goes.
{
  activate(); title(); newGame();
  expect(started() === 1, 'a new game starts the attempt');
  setScore(12300); frames(2); die(); die();
  expect(!submitted().length, 'deaths with lives left submit nothing');
  setScore(45600); frames(2);
  die();
  const s = submitted();
  expect(s.length === 1 && s[0].value === 45600, `game over submits the score (got ${s.map((e) => e.value)})`);
  title(); frames(30);
  expect(submitted().length === 1, 'the title submits nothing more');
  newGame();
  expect(started() === 2, 'the next game starts a new attempt');
  ok('High Score start, submit and value');
}

// 12. A game with no points is not submitted.
{
  activate(); title(); newGame(); gameOver();
  expect(started() === 1 && !submitted().length, 'a pointless game submits nothing');
  ok('an empty game is not submitted');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - nemesis set: ${testNo} checks`);
