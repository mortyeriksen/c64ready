// Spec tests for the Bomb Jack achievement set (server/sets/bomb-jack.json, the Elite 1986 C64
// game on the OneLoad64 v5 cartridge) under rcheevos, on synthesized RAM laid out as the game
// keeps it:
//   $122F-$1231 score, six BCD digits, high byte first.
//   $14F7 lives: 1 for a new game (two Jacks in the panel), 0, then $FF on the last life.
//         A death on $FF ends the game. An E coin adds one, up to 5.
//   $150E round, BCD. $1E94 rises when a round is cleared, before the firebomb bonus.
//   $3C5F lit bombs taken this round: 20 or more pays the firebomb bonus, 23 pays 50,000.
//   $536B the bonus multiplier digit in the panel, 1 at each round start, +1 per B coin.
//   $11ED P-coin power timer: $96 when a P coin is caught, counting down after.
//   $1BE6 dying flag: 1 from Jack's death until his death animation ends.
//   $0315 IRQ vector high byte: $16 while a round is played, $09 on the title, the
//         high-score screens, game over and between rounds (a new game sits there
//         with lives 1, round 1 and no score until its first round starts).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/bomb-jack.json'), 'utf8')), 'bomb-jack.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = '9f27d4a5ea48e17610fba4ae4e5ca795';
const SCORE = 0x122f, LIVES = 0x14f7, ROUND = 0x150e, CLEARED = 0x1e94, LIT = 0x3c5f, MULT = 0x536b, POWER = 0x11ed, DYING = 0x1be6, IRQ = 0x315;
const PLAY = 0x16, BETWEEN = 0x09;

const bcd = (n) => parseInt(String(n), 16);
/** The score as the game stores it: six BCD digits, high byte first. */
function setScore(n) {
  const d = String(n).padStart(6, '0');
  for (let i = 0; i < 3; i++) ram[SCORE + i] = parseInt(d.slice(2 * i, 2 * i + 2), 16);
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

/** The title after power-on: IRQ $09xx, nothing set, the multiplier cell holding title text. */
function title() { ram[IRQ] = BETWEEN; ram[LIVES] = 0; ram[ROUND] = 0; setScore(0); ram[MULT] = 0xfe; frames(10); }
/** A new game: set up between screens, then round 1 is played. */
function newGame() {
  ram[IRQ] = BETWEEN; ram[LIVES] = 1; ram[ROUND] = 1; setScore(0); ram[MULT] = 1; ram[LIT] = 0; ram[CLEARED] = 0; ram[DYING] = 0;
  frames(90);
  ram[IRQ] = PLAY; frames(5);
}
/** Clear the current round with `lit` lit bombs, pay the bonus between screens, start the next round. */
function clearRound(lit = 0, bonus = 0) {
  ram[LIT] = lit; frames(1);
  ram[CLEARED] = 1; frames(3);
  ram[IRQ] = BETWEEN; frames(2);
  if (bonus) { const s = scoreNow() + bonus; setScore(s); }
  frames(50);
  ram[ROUND] = bcd(Number(ram[ROUND].toString(16)) + 1); ram[CLEARED] = 0; ram[LIT] = 0; ram[MULT] = 1; frames(10);
  ram[IRQ] = PLAY; frames(5);
}
function scoreNow() { return Number([0, 1, 2].map((i) => ram[SCORE + i].toString(16).padStart(2, '0')).join('')); }
/** A death: the animation, then the main loop takes a life (0 wraps to $FF). The round goes on. */
function die() { ram[DYING] = 1; frames(140); ram[DYING] = 0; frames(1); ram[LIVES] = (ram[LIVES] - 1) & 0xff; frames(5); }
/** The death on the last life: the animation ends with lives still $FF, then game over. */
function gameOver() { ram[LIVES] = 0xff; ram[DYING] = 1; frames(140); ram[DYING] = 0; frames(1); ram[IRQ] = BETWEEN; frames(30); }

// 1. Every condition and the leaderboard parse, and the set names the cartridge.
{
  const { codes, boards } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.length === 1 && boards[0] === 0, 'the high-score leaderboard parses');
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names Bomb Jack.crt');
  expect(set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'High Score is a SCORE board, higher is better');
  ok(`all ${codes.length} achievements and ${boards.length} leaderboard parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('bomb-jack-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'bomb-jack-crt is not registered in test/external-assets.json';
    try { note = missingNote('bomb-jack-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the OneLoad64 cartridge hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the OneLoad64 cartridge hashes to the listed hash'); }
}

// 3. Power-on junk while the cartridge loads, then the title: nothing fires.
{
  activate();
  ram[IRQ] = 0xea; ram[LIVES] = 1; ram[ROUND] = 0x36; ram.set([0x8d, 0x06, 0xc0], SCORE); ram[MULT] = 0xff; frames(5);
  ram[CLEARED] = 1; ram[LIT] = 23; ram[POWER] = 0x96; frames(3);
  ram[MULT] = 0; ram[LIVES] = 0; ram[CLEARED] = 0; ram[POWER] = 0; frames(3);
  title();
  for (let i = 0; i < 6; i++) { ram[MULT] = i; frames(20); }
  expect(unlocked.size === 0, `nothing unlocks before a game (got ${[...unlocked]})`);
  expect(started() === 0, 'no high-score attempt starts before a game');
  ok('power-on and the title unlock nothing');
}

// 4. Score tiers, from a new game, at the shown score.
{
  activate(); title(); newGame();
  expect(started() === 1, 'a new game starts the high-score attempt');
  const tiers = [['Bomb Squad', 20000], ['Demolition Expert', 50000], ['Top Bombjacker', 100000], ['Caped Crusader', 250000], ['Bomb Jack Legend', 500000]];
  for (const [t, pts] of tiers) {
    setScore(pts - 10); frames(2);
    expect(!has(t), `${t}: ${pts - 10} is short of ${pts}`);
    setScore(pts); frames(2);
    expect(has(t), `${t} at ${pts} points`);
  }
  ok('score tiers at 20,000, 50,000, 100,000, 250,000 and 500,000');
}

// 5. A score kept on the title after a game over unlocks nothing.
{
  activate(); title(); newGame(); setScore(12340); frames(2); gameOver();
  setScore(600000); frames(5);
  expect(unlocked.size === 0, `the title is not play (got ${[...unlocked]})`);
  ok('scores off the play screens unlock nothing');
}

// 6. Round clears: rounds 1 to 5 and 10, each on its own round.
{
  activate(); title(); newGame();
  const rounds = { 1: 'Riddle of the Sphinx', 2: 'Acropolis Now', 3: 'King of the Castle', 4: 'City Slicker', 5: 'Grand Tour', 10: 'Second Tour' };
  for (let r = 1; r <= 10; r++) {
    const t = rounds[r];
    if (t) expect(!has(t), `${t} not before round ${r} is cleared`);
    clearRound();
    if (t) expect(has(t), `${t} when round ${r} is cleared`);
  }
  expect(Object.values(rounds).every((t) => has(t)), 'all six round achievements');
  ok('rounds 1 to 5 and 10');
}

// 7. The firebomb bonus: 20 lit bombs and 23 lit bombs, counted when the round is cleared.
{
  activate(); title(); newGame();
  clearRound(19);
  expect(!has('Firebomb Bonus'), '19 lit bombs earn no bonus');
  clearRound(20, 20000);
  expect(has('Firebomb Bonus'), 'Firebomb Bonus at 20 lit bombs');
  clearRound(22, 20000);
  expect(!has('Perfect Sequence'), '22 lit bombs are not the 50,000 bonus');
  clearRound(23, 50000);
  expect(has('Perfect Sequence'), 'Perfect Sequence at 23 lit bombs');
  ok('firebomb bonus achievements');
}

// 8. Coins: P (power timer set to $96) and B (multiplier steps up), not the round start's reset.
{
  activate(); title(); newGame();
  ram[POWER] = 0x96; frames(1);
  expect(has('Power Play'), 'Power Play when the power timer is set');
  for (let t = 0x95; t > 0; t--) { ram[POWER] = t; frame(); }
  ram[MULT] = 2; frames(2);
  expect(has('Bonus Multiplier'), 'Bonus Multiplier when the multiplier goes 1 to 2');
  ram[MULT] = 3; frames(2); ram[MULT] = 4; frames(2);
  expect(!has('Five Times Over'), 'x4 is not x5');
  clearRound();
  expect(!has('Five Times Over') && ram[MULT] === 1, 'the next round starts back at x1');
  ram[MULT] = 4; frames(2); ram[MULT] = 5; frames(2);
  expect(has('Five Times Over'), 'Five Times Over at x5');
  ok('P and B coins');
}

// 9. The multiplier cell between rounds and on the title is not a B coin.
{
  activate(); title(); newGame(); ram[MULT] = 3; frames(2); unlocked.clear();
  activate(); title(); newGame();
  ram[IRQ] = BETWEEN; ram[MULT] = 4; frames(2); ram[MULT] = 5; frames(2);
  expect(!has('Bonus Multiplier') && !has('Five Times Over'), 'no multiplier achievement between screens');
  ok('the multiplier only counts in play');
}

// 10. The E coin: a life gained in play, including on the last life ($FF to 0).
{
  activate(); title(); newGame(); setScore(3000);
  die();
  expect(ram[LIVES] === 0 && !has('Extra Life'), 'a death (1 to 0) is not a life gained');
  die();
  expect(ram[LIVES] === 0xff && !has('Extra Life'), 'a death (0 to $FF) is not a life gained');
  ram[LIVES] = 0; frames(2);
  expect(has('Extra Life'), 'Extra Life from an E coin on the last life');

  activate(); title(); newGame(); ram[LIVES] = 2; frames(2);
  expect(has('Extra Life'), 'Extra Life from an E coin, 1 to 2');

  activate(); title(); newGame(); gameOver(); newGame();
  expect(!has('Extra Life'), 'the next game\'s lives ($FF to 1, between screens) are no E coin');
  ok('E coin');
}

// 11. Unscathed: a round from its start to its clear without a death.
{
  activate(); title(); newGame(); setScore(500);
  die(); clearRound();
  expect(has('Riddle of the Sphinx') && !has('Unscathed'), 'a death in round 1 rules it out for round 1');
  clearRound();
  expect(has('Unscathed'), 'Unscathed for a clean round 2');
  ok('Unscathed');
}

// 12. Flawless Five: rounds 1 to 5 of one game without a death.
{
  activate(); title(); newGame();
  for (let r = 1; r <= 5; r++) clearRound();
  expect(has('Flawless Five'), 'Flawless Five after five clean rounds');

  activate(); title(); newGame();
  clearRound(); clearRound(); die(); clearRound(); clearRound(); clearRound();
  expect(has('Grand Tour') && !has('Flawless Five'), 'a death in round 3 rules it out');
  ok('Flawless Five');
}

// 13. High Score: submitted when the last life's death ends the game, not on other deaths.
{
  activate(); title(); newGame(); setScore(45670); frames(2);
  die(); die();
  expect(!submitted().length, 'deaths with lives left submit nothing');
  clearRound(); setScore(58900); frames(2);
  expect(started() === 1, 'one attempt for the game');
  gameOver();
  const s = submitted();
  expect(s.length === 1 && s[0].value === 58900, `game over submits the shown score (got ${s.map((e) => e.value)})`);
  title(); frames(30);
  expect(submitted().length === 1, 'the title submits nothing more');
  newGame();
  expect(started() === 2, 'the next game starts a new attempt');
  ok('High Score start, submit and value');
}

// 14. A game with no points is not submitted.
{
  activate(); title(); newGame(); die(); die(); gameOver();
  expect(started() === 1 && !submitted().length, 'a pointless game submits nothing');
  ok('an empty game is not submitted');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - bomb-jack set: ${testNo} checks`);
