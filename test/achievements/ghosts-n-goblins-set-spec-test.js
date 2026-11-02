// Spec tests for the Ghosts 'n Goblins achievement set (server/sets/ghosts-n-goblins.json,
// the Elite 1986 C64 game on the OneLoad64 v5 cartridge) under rcheevos, on synthesized
// RAM laid out as the game keeps it:
//   $3536 stage index: 0-3 while a stage is played, 4 on the title, 5 on the high-score
//         table and on the ending walk after stage 4. A new game stores 0 there, clears
//         the score and arms the player, with lives already 5 from the game over.
//         High-score name entry flashes it to 4 and back to the stage.
//   $3591 stage exit flag: rises when the player, holding the boss's key, reaches the
//         exit. The stage index steps up in the same game loop pass (3 goes to 5). The
//         flag stays up through the ending walk and the loop back to stage 1, while a new
//         game always starts with it down.
//   $3598/$3599 score in BCD, the shown score being those four digits and "00".
//   $359A lives: 5 for a new game (four spare icons), one more at 50,000 points. On the
//         last life it stays 1 through the high-score check, then returns to 5.
//   $3527 armour: $40 armoured, $80 after the first hit, $C0 on the fatal hit.
//   $3528 weapon: 1 lance, 2 torch, 3 dagger, 4 axe, 5 shield. A dropped weapon is the
//         next in that order, so each pickup steps it by one (5 wraps to 1).
//   $3593 dying flag: 1 from a fatal hit or the timer running out until the respawn, and
//         left at 1 after a game over until the next game's first frames.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { checkSet } from '../../server/games.mjs';
import { assetPath } from '../external-assets.js';

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/ghosts-n-goblins.json'), 'utf8')), 'ghosts-n-goblins.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = 'f2056bc55e1b4b092a6fe43794b25b4d';
const STAGE = 0x3536, EXIT = 0x3591, SCORE = 0x3598, LIVES = 0x359a, ARMOUR = 0x3527, WEAPON = 0x3528, DYING = 0x3593;
const LANCE = 1, TORCH = 2, DAGGER = 3, AXE = 4, SHIELD = 5;

/** The shown score as the game stores it: shown / 100 in four BCD digits, high byte first. */
function setScore(shown) {
  const d = String(shown / 100).padStart(4, '0');
  ram[SCORE] = parseInt(d.slice(0, 2), 16);
  ram[SCORE + 1] = parseInt(d.slice(2), 16);
}
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

/** The title screen after power-on: stage 4, lives 5, lance, nothing else set. */
function title(stage = 4) { ram[STAGE] = stage; ram[LIVES] = 5; ram[WEAPON] = LANCE; ram[ARMOUR] = 0xff; frames(10); }
/** A new game: stage 0, score cleared, then the player is armoured and alive. */
function newGame() {
  ram[STAGE] = 0; setScore(0); ram[LIVES] = 5; ram[WEAPON] = LANCE; frames(1);
  ram[ARMOUR] = 0x40; ram[DYING] = 0; ram[EXIT] = 0; frames(5);
}
/** Stage n's exit as the game loop does it: the flag rises and the index steps in the same pass. */
function clearStage(n, { sameFrame = true } = {}) {
  if (!sameFrame) { ram[EXIT] = 1; frames(1); }
  ram[EXIT] = 1; ram[STAGE] = n === 4 ? 5 : n; frames(1);
  if (n === 4) frames(150);                    // the ending walk, still flagged
  ram[STAGE] = n === 4 ? 0 : n; frames(1);
  ram[EXIT] = 0; ram[ARMOUR] = 0x40; frames(5);
}
/** A hit that takes the armour, and a death (a second hit or the clock) and respawn. */
function hit() { ram[ARMOUR] = 0x80; frames(5); }
function die() { ram[ARMOUR] = 0xc0; frames(1); ram[DYING] = 1; frames(130); ram[LIVES]--; ram[ARMOUR] = 0x40; ram[DYING] = 0; frames(5); }
/** Game over on the last life: lives stay 1 through the high-score check, then 5 and the title. */
function gameOver() {
  ram[ARMOUR] = 0xc0; ram[DYING] = 1; frames(130);
  const stage = ram[STAGE];
  ram[STAGE] = 4; frames(20); ram[STAGE] = stage; frames(2);   // name entry
  ram[LIVES] = 5; ram[STAGE] = 4; frames(10);
}

// 1. Every condition and the leaderboard parse, and the set names the cartridge.
{
  const { codes, boards } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.length === 1 && boards[0] === 0, 'the high-score leaderboard parses');
  expect(set.hashes.some((h) => h.hash === HASH), "the set names Ghosts'n Goblins.crt");
  expect(set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'High Score is a SCORE board, higher is better');
  ok(`all ${codes.length} achievements and ${boards.length} leaderboard parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  const file = assetPath('ghosts-n-goblins-crt');
  if (!file) console.log(`ok  - test ${++testNo}: the OneLoad64 cartridge hashes to the listed hash # SKIP asset ghosts-n-goblins-crt not found (test/external-assets.json)`);
  else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the OneLoad64 cartridge hashes to the listed hash'); }
}

// 3. Power-on junk before the title: stage 0, a high score, weapons and the exit flag moving.
{
  activate();
  ram[STAGE] = 0; ram[LIVES] = 0xff; setScore(999900); frames(5);
  for (let w = 1; w <= 5; w++) { ram[WEAPON] = w; frames(2); }
  ram[EXIT] = 1; frames(2); ram[EXIT] = 0; frames(2); ram[STAGE] = 3; ram[EXIT] = 1; frames(2);
  ram[STAGE] = 0xff; ram[EXIT] = 0; frames(2);
  title(); setScore(0); frames(10);
  expect(unlocked.size === 0, `nothing unlocks before a game has started (got ${[...unlocked]})`);
  expect(started() === 0, 'no high-score attempt starts before a game');
  ok('power-on and the title unlock nothing');
}

// 4. The title and high-score table alternate (4 and 5) with the last game's score showing.
{
  activate(); title(); setScore(120000);
  for (let i = 0; i < 4; i++) { ram[STAGE] = 5; frames(30); ram[STAGE] = 4; frames(30); }
  expect(unlocked.size === 0 && started() === 0, 'the attract screens unlock nothing and start no attempt');
  ok('the title and high-score table are not a game');
}

// 5. Score tiers, from a new game, at the shown score.
{
  activate(); title(); newGame();
  expect(started() === 1, 'a new game starts the high-score attempt');
  const tiers = [['Knight Errant', 5000], ['Ghost Buster', 10000], ['Goblin Slayer', 25000], ['Bonus Knight', 50000], ['Legendary Knight', 100000]];
  for (const [t, pts] of tiers) {
    setScore(pts - 100); frames(2);
    expect(!has(t), `${t}: ${pts - 100} is short of ${pts}`);
    setScore(pts); frames(2);
    expect(has(t), `${t} at ${pts} points`);
  }
  ok('score tiers unlock at 5,000, 10,000, 25,000, 50,000 and 100,000');
}

// 6. Score tiers need a game in play: a score left on the title after a game over.
{
  activate(); title(); newGame(); setScore(2000); frames(2);
  ram[LIVES] = 1; gameOver();
  setScore(60000); frames(5);
  expect(unlocked.size === 0, `a score on the title unlocks nothing (got ${[...unlocked]})`);
  ok('the title after a game over is not play');
}

// 7. Weapon pickups step through the cycle. The new game's return to the lance is not one.
{
  activate(); title(); ram[WEAPON] = DAGGER; frames(5); newGame();
  expect(unlocked.size === 0, 'a new game resetting the dagger to the lance unlocks nothing');
  const steps = [['Firestarter', TORCH], ['Cold Steel', DAGGER], ['Axe to Grind', AXE], ['Shield Bearer', SHIELD]];
  for (const [t, w] of steps) {
    expect(!has(t), `${t} not before its pickup`);
    ram[WEAPON] = w; frames(2);
    expect(has(t), `${t} when the weapon becomes ${w}`);
  }
  ram[WEAPON] = LANCE; frames(2);
  expect(unlocked.size === 4, 'the lance again is no achievement');
  ok('torch, dagger, axe and shield pickups');
}

// 8. Weapon changes on the title, from a previous game's weapon, are not pickups.
{
  activate(); title(); newGame(); ram[LIVES] = 1; gameOver();
  ram[WEAPON] = AXE; frames(3); ram[WEAPON] = SHIELD; frames(3);
  expect(unlocked.size === 0, `no pickup off the play screens (got ${[...unlocked]})`);
  ok('weapon bytes on the title unlock nothing');
}

// 9. Each stage's exit unlocks its achievement, whether the index steps in the same frame or the next.
{
  activate(); title(); newGame();
  clearStage(1);
  expect(has('Graveyard Shift'), 'Graveyard Shift on stage 1\'s exit');
  expect(!has('Tower Climber'), 'not Tower Climber on stage 1');
  clearStage(2, { sameFrame: false });
  expect(has('Tower Climber'), 'Tower Climber on stage 2\'s exit, the flag a frame ahead of the index');
  clearStage(3);
  expect(has('Stepping Stones'), 'Stepping Stones on stage 3\'s exit');
  expect(!has('Thin Ice'), 'not Thin Ice before stage 4');
  clearStage(4);
  expect(has('Thin Ice'), 'Thin Ice on stage 4\'s exit (index 3 to 5)');
  ok('stage exits 1 to 4');
}

// 10. The loop back to stage 1 (index 5 to 0 with the flag still up) is not stage 1's exit.
{
  activate(); title(); newGame();
  ram[STAGE] = 3; frames(5);
  clearStage(4);
  expect(!has('Graveyard Shift'), 'the loop does not count as clearing stage 1');
  expect([...unlocked].every((u) => u === id['Thin Ice']), `only Thin Ice (got ${[...unlocked]})`);
  ok('the ending\'s loop to stage 1 is not an exit');
}

// 11. The high-score name entry flashes the stage index 3 to 4 and back: no stage 4 exit.
{
  activate(); title(); newGame(); ram[STAGE] = 3; ram[LIVES] = 1; setScore(4000); frames(5);
  gameOver();
  expect(!has('Thin Ice'), 'name entry on stage 4 is not its exit');
  ok('name entry is not a stage clear');
}

// 12. Not a Scratch: stage 1 of a new game with no hit and no death.
{
  activate(); title(); newGame(); clearStage(1);
  expect(has('Fully Dressed'), 'a clean stage 1 unlocks Not a Scratch');

  activate(); title(); newGame(); hit(); clearStage(1);
  expect(has('Graveyard Shift') && !has('Fully Dressed'), 'losing the armour rules it out');

  activate(); title(); newGame();
  ram[DYING] = 1; frames(130); ram[LIVES]--; ram[DYING] = 0; frames(5);   // the clock ran out
  clearStage(1);
  expect(!has('Fully Dressed'), 'a death by the clock rules it out');

  activate(); title(); newGame(); hit(); die(); clearStage(1); clearStage(2); clearStage(3); clearStage(4);
  clearStage(1);
  expect(!has('Fully Dressed'), 'stage 1 on the second round does not count after a hit');
  ok('Not a Scratch needs stage 1 clean from a new game');
}

// 13. The dying flag left up from the last game ends a few frames into the new one: it is not a death.
{
  activate(); title(); newGame(); ram[LIVES] = 1; gameOver();
  expect(ram[DYING] === 1, 'the dying flag is still up on the title');
  ram[STAGE] = 0; setScore(0); ram[LIVES] = 5; ram[WEAPON] = LANCE; frames(2);
  ram[ARMOUR] = 0x40; ram[DYING] = 0; frames(5);
  clearStage(1);
  expect(has('Fully Dressed'), 'Not a Scratch after a game that ended in a death');
  ok('the last game\'s dying flag does not spoil the next');
}

// 14. Round Two: stage 1 cleared again after stage 4, in the same game.
{
  activate(); title(); newGame(); clearStage(1);
  expect(!has('It Was All a Dream'), 'not on the first stage 1');
  clearStage(2); clearStage(3); clearStage(4);
  expect(!has('It Was All a Dream'), 'not on stage 4 itself');
  clearStage(1);
  expect(has('It Was All a Dream'), 'Round Two on stage 1 after stage 4');

  activate(); title(); newGame(); ram[STAGE] = 3; frames(2); clearStage(4);
  ram[LIVES] = 1; gameOver(); newGame(); clearStage(1);
  expect(!has('It Was All a Dream'), 'a game over in between cancels it');

  activate(); title(); newGame(); ram[STAGE] = 3; frames(2); clearStage(4);
  title(); newGame(); clearStage(1);
  expect(!has('It Was All a Dream'), 'a new game without a game over (a reset) cancels it');
  ok('It Was All a Dream');
}

// 15. High Score: one attempt per game, submitted on the last life's game over with the shown score.
{
  activate(); title(); newGame();
  setScore(12300); ram[LIVES] = 1; frames(3);
  ram[LIVES] = 2; frames(3);                                  // 50,000-point style bonus life: 1 to 2
  expect(!submitted().length, 'a bonus life is not a game over');
  die(); expect(ram[LIVES] === 1, 'lost the bonus life');
  ram[STAGE] = 3; clearStage(4);
  expect(!submitted().length && started() === 1, 'the loop after stage 4 neither submits nor restarts');
  setScore(45600); frames(2);
  gameOver();
  const s = submitted();
  expect(s.length === 1 && s[0].value === 45600, `game over submits the shown score (got ${s.map((e) => e.value)})`);
  frames(30);
  expect(submitted().length === 1, 'the title submits nothing more');
  newGame();
  expect(started() === 2, 'the next game starts a new attempt');
  ok('High Score start, submit and value');
}

// 16. A game with no points is not submitted.
{
  activate(); title(); newGame(); ram[LIVES] = 1; frames(3); gameOver();
  expect(started() === 1 && !submitted().length, 'a pointless game submits nothing');
  ok('an empty game is not submitted');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - ghosts-n-goblins set: ${testNo} checks`);
