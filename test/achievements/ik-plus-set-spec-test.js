// Spec tests for the IK+ achievement set (server/sets/ik-plus.json, System 3's International
// Karate + on the OneLoad64 v5 cartridge) under rcheevos, on synthesized RAM laid out as the game
// keeps it:
//   $45/$46 human flags for the white (port 2) and red (port 1) fighters; $48 the number of humans.
//         The attract demo has none. Fire on port 2 starts a game against the computer ($48 = 1),
//         fire on port 1 a two-player game ($48 = 2).
//   $66 phase: 0 setting up, 1 fighting, 3 the fight is over, 4 game over (the player came last),
//         5 bonus round.
//   $010C level, BCD, +1 per fight and per bonus round (a bonus round follows every second fight).
//   $010F/$0110/$0111 points this fight for white, red and blue. A fight ends at six points or
//         when the clock runs out; the ranking is by points, then by the fight's score.
//   $0195 white's score this fight or bonus round, in hundreds (BCD).
//   $0113/$0114 white's score in BCD, shown with "00" after. The belt follows it: yellow from
//         8,000, green 16,000, purple 25,000, brown 35,000, black 50,000.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/ik-plus.json'), 'utf8')), 'ik-plus.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = '819c741a29030beb67cbb36d8379f9d7';
const WHITE_HUMAN = 0x45, RED_HUMAN = 0x46, HUMANS = 0x48, PHASE = 0x66, LEVEL = 0x10c, POINTS = 0x10f, FIGHT = 0x195, SCORE = 0x113;
const SETUP = 0, FIGHTING = 1, OVER = 3, GAME_OVER = 4, BONUS = 5;

const bcd = (n) => parseInt(String(n), 16);
/** White's score: shown / 100 as four BCD digits. */
function setScore(shown) { const d = String(shown / 100).padStart(4, '0'); ram[SCORE] = parseInt(d.slice(0, 2), 16); ram[SCORE + 1] = parseInt(d.slice(2), 16); }
const scoreNow = () => Number(ram[SCORE].toString(16) + ram[SCORE + 1].toString(16).padStart(2, '0')) * 100;
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

/** The attract demo: the computer fights itself, scoring and levelling up. */
function demo() {
  ram[WHITE_HUMAN] = 0; ram[RED_HUMAN] = 0; ram[HUMANS] = 0;
  ram[PHASE] = SETUP; ram[LEVEL] = 1; frames(2); ram[PHASE] = FIGHTING; frames(5);
  ram[POINTS] = 6; setScore(60000); ram[FIGHT] = 0x30; frames(5);
  ram[PHASE] = OVER; frames(5); ram[PHASE] = BONUS; ram[LEVEL] = bcd(20); frames(5); ram[FIGHT] = 0x31; frames(5);
}
/** A new game: phase 0 clears everything, then level 1's first fight. Port 2 alone is one player. */
function newGame(twoPlayers = false) {
  ram[WHITE_HUMAN] = 1; ram[RED_HUMAN] = twoPlayers ? 1 : 0; ram[HUMANS] = twoPlayers ? 2 : 1;
  ram[PHASE] = SETUP; frames(1);
  ram[LEVEL] = 0; setScore(0); ram[POINTS] = ram[POINTS + 1] = ram[POINTS + 2] = 0; ram[FIGHT] = 0; frames(4);
  ram[LEVEL] = 1; ram[PHASE] = FIGHTING; frames(10);
}
/** A fight: points for white, red and blue, white's points scored on the way, then the fight is over. */
function fight(white, red, blue, whiteFight = white * 2) {
  ram[POINTS] = white; ram[POINTS + 1] = red; ram[POINTS + 2] = blue;
  ram[FIGHT] = bcd(whiteFight); setScore(scoreNow() + whiteFight * 100); frames(10);
  ram[PHASE] = OVER; frames(20);
}
/** The next level (the next fight or a bonus round). */
function next(phase = FIGHTING) {
  ram[LEVEL] = bcd(Number(ram[LEVEL].toString(16)) + 1); ram[POINTS] = ram[POINTS + 1] = ram[POINTS + 2] = 0; ram[FIGHT] = 0;
  ram[PHASE] = phase; frames(10);
}
function gameOver() { ram[PHASE] = GAME_OVER; frames(30); ram[WHITE_HUMAN] = 0; ram[HUMANS] = 0; frames(10); }

// 1. Every condition and the leaderboard parse, and the set names the cartridge.
{
  const { codes, boards } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.length === 1 && boards[0] === 0, 'the high-score leaderboard parses');
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names IK+.crt');
  expect(set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'High Score is a SCORE board, higher is better');
  ok(`all ${codes.length} achievements and ${boards.length} leaderboard parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('ik-plus-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'ik-plus-crt is not registered in test/external-assets.json';
    try { note = missingNote('ik-plus-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the OneLoad64 cartridge hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the OneLoad64 cartridge hashes to the listed hash'); }
}

// 3. The attract demo unlocks nothing and starts no attempt.
{
  activate(); demo(); demo();
  expect(unlocked.size === 0 && started() === 0, `the demo counts for nothing (got ${[...unlocked]})`);
  ok('the attract demo is not a game');
}

// 4. A two-player game unlocks nothing; nor does a later one after a one-player game.
{
  activate(); newGame(true); fight(6, 0, 0, 30); next(); setScore(60000); frames(5); next(BONUS); ram[FIGHT] = 5; frames(5); gameOver();
  expect(unlocked.size === 0 && started() === 0, `a two-player game counts for nothing (got ${[...unlocked]})`);

  activate(); newGame(); fight(1, 2, 3); gameOver();
  newGame(true); fight(6, 0, 0, 30); setScore(60000); frames(5);
  expect(unlocked.size === 0, `an earlier one-player game does not open a two-player one (got ${[...unlocked]})`);
  expect(started() === 1 && submitted().length === 1 && submitted()[0].value === 200, 'only the one-player game had an attempt, submitted at its game over');
  ok('two players are kept out');
}

// 5. Belts at the score thresholds.
{
  activate(); newGame();
  for (const [t, pts] of [['Yellow Belt', 8000], ['Green Belt', 16000], ['Purple Belt', 25000], ['Brown Belt', 35000], ['Black Belt', 50000]]) {
    setScore(pts - 100); frames(2);
    expect(!has(t), `${t}: ${pts - 100} is short`);
    setScore(pts); frames(2);
    expect(has(t), `${t} at ${pts}`);
  }
  ok('belts');
}

// 6. Winning fights: more points than both, six points, and a clean sheet.
{
  activate(); newGame(); fight(3, 3, 1);
  expect(!has('Top of the Podium'), 'a points tie with red is not an outright win');
  next(); fight(4, 3, 2);
  expect(has('Top of the Podium') && !has('Six of the Best'), 'Top of the Podium with 4 points to 3 and 2');
  next(); fight(6, 2, 0);
  expect(has('Six of the Best') && !has('Clean Sheet'), 'Six of the Best at six points; red scored, so no clean sheet');
  next(); fight(6, 0, 0);
  expect(has('Clean Sheet'), 'Clean Sheet at six points to nothing');
  ok('fight wins');
}

// 7. Bonus rounds and levels.
{
  activate(); newGame(); fight(2, 1, 1); next(); fight(2, 1, 1);
  expect(!has('Have a Ball'), 'no bonus round yet');
  next(BONUS);
  expect(has('Have a Ball') && !has('Deflector'), 'Bonus Round at level 3');
  ram[FIGHT] = 1; frames(2);
  expect(has('Deflector'), 'Deflector for the first bonus points');
  next(); fight(2, 1, 1);
  expect(ram[LEVEL] === 4 && !has('Level 5'), 'level 4 is not 5');
  next();
  expect(has('Level 5'), 'Level 5');
  while (ram[LEVEL] !== bcd(20)) { fight(2, 1, 1); next(); }
  expect(has('Level 10') && has('Level 20'), 'Level 10 and Level 20');
  ok('bonus rounds and levels');
}

// 8. Fight points during the bonus setup or a fight are not bonus points.
{
  activate(); newGame(); ram[FIGHT] = 3; frames(2);
  expect(!has('Deflector'), 'fight points are not bonus points');
  ok('Deflector needs a bonus round');
}

// 9. High Score: submitted at game over (the player came last), with the shown score.
{
  activate(); newGame();
  expect(started() === 1, 'a one-player game starts the attempt');
  fight(3, 1, 2); next(); fight(1, 4, 2);
  expect(!submitted().length, 'nothing is submitted while the game goes on');
  const final = scoreNow();
  gameOver();
  const s = submitted();
  expect(s.length === 1 && s[0].value === final, `game over submits ${final} (got ${s.map((e) => e.value)})`);
  demo();
  expect(submitted().length === 1 && started() === 1, 'the demo afterwards submits and starts nothing');
  newGame();
  expect(started() === 2, 'the next game starts a new attempt');
  ok('High Score start, submit and value');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - ik-plus set: ${testNo} checks`);
