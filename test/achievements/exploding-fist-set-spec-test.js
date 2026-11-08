// Spec tests for The Way of the Exploding Fist achievement set (server/sets/exploding-fist.json,
// the Melbourne House 1985 C64 game on the OneLoad64 v5 cartridge and programs) under rcheevos, on synthesized
// RAM laid out as the game keeps it:
//   $65 demo flag: 1 while the title demo fights itself, 0 in a game.
//   $AE two-player flag (F3 on the title): 0 for a game against the computer.
//   $AF dan: 0 novice, 1-10. The demo and the two-player game use it as a bout counter, so it
//         only means a dan with $65 = 0 and $AE = 0.
//   $B5 contests still to win before the next dan: 2, one less per contest won, 2 again when the
//         dan goes up. Losing a contest ends the game.
//   $8A/$8B half points this contest for the player and the computer, cleared when it ends.
//   $5A 1 for a frame or two at a stop in a contest (a half point, a tie), and from the stop that
//         loses the game until $65 goes back to 1.
//   $C2 the bull stage's result (between 3rd and 4th dan, and 7th and 8th): $80 when the
//         bull is beaten.
//   $CC31-$CC36 the player's score as screen characters, digits ($30-$39) or leading spaces ($20);
//         $CC34 is the hundreds, $CC35/$CC36 always "0". After a lost contest the high-score table
//         is drawn over the screen, its second row over the score, in the frames before $65 goes
//         back to 1.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/exploding-fist.json'), 'utf8')), 'exploding-fist.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASHES = { 'exploding-fist-crt': '228d147421640b3b602144271e328aa3', 'exploding-fist-prg-crunched': '0c76915ef88e189df0e445f703e4074b', 'exploding-fist-prg-uncrunched': '81fb5d349a2ad97afcecd46e34ad2f3f' };
const DEMO = 0x65, TWO = 0xae, DAN = 0xaf, TO_WIN = 0xb5, HALF = 0x8a, CPU_HALF = 0x8b, BULL = 0xc2, SCORE = 0xcc31, OVER = 0x5a;

/** The score on screen: six characters, leading spaces, the last two always "0". */
function setScore(n) {
  const s = n ? String(n).padStart(6, ' ') : '     0';
  for (let i = 0; i < 6; i++) ram[SCORE + i] = s.charCodeAt(i);
}
const scoreNow = () => Number(String.fromCharCode(...ram.subarray(SCORE, SCORE + 6)).trim() || 0);
const unlocked = new Set();
const primed = new Set();   // challenges that can still be earned (rcheevos PRIMED, until UNPRIMED)
const lb = [];
function activate() {
  rc.clear(); unlocked.clear(); primed.clear(); lb.length = 0; ram.fill(0);
  return {
    codes: set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr)),
    boards: set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition)),
  };
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type === EVENT.ACHIEVEMENT_PRIMED) primed.add(e.id);
    else if (e.type === EVENT.ACHIEVEMENT_UNPRIMED) primed.delete(e.id);
    else if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED && e.type !== EVENT.LBOARD_UPDATED) lb.push({ ...e });
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const started = () => lb.filter((e) => e.type === EVENT.LBOARD_STARTED).length;
const submitted = () => lb.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
const has = (title) => unlocked.has(id[title]);

/** The title demo: the computer fights itself, its bout counter in $AF climbing. */
function demo() {
  ram[DEMO] = 1; ram[TWO] = 0; setScore(0); frames(5);
  for (let i = 1; i <= 4; i++) { ram[DAN] = i; ram[CPU_HALF] = 0; ram[HALF] = 4; frames(3); ram[HALF] = 0; frames(3); }
  setScore(30000); ram[BULL] = 0x80; frames(5); ram[BULL] = 0; setScore(0); ram[DAN] = 0; frames(5);
}
/** A new game from the title (where the demo runs): the demo flag drops with novice rank and two contests to win. */
function newGame(two = false) {
  ram[TWO] = two ? 1 : 0; ram[DEMO] = 1; frames(2); ram[DEMO] = 0; ram[DAN] = 0; ram[TO_WIN] = 2; ram[HALF] = 0; ram[CPU_HALF] = 0; setScore(0); frames(10);
}
/** A contest won: half points scored, then cleared as $B5 steps (and the dan goes up after two). */
function winContest(cpuHalves = 0, points = 2000) {
  ram[CPU_HALF] = cpuHalves; ram[HALF] = 4; setScore(scoreNow() + points); frames(5);
  ram[HALF] = 0; ram[CPU_HALF] = 0;
  if (ram[TO_WIN] === 2) ram[TO_WIN] = 1; else { ram[TO_WIN] = 2; ram[DAN]++; }
  frames(10);
}
/**
 * The contest lost: the computer ahead as the contest ends, the high-score table's second row
 * (`table`, six characters) drawn over the score, then game over, the score cleared as the demo returns.
 */
function loseContest(table = null, halves = [0, 4]) {
  [ram[HALF], ram[CPU_HALF]] = halves; frames(20); ram[OVER] = 1; frames(2);
  if (table) { for (let i = 0; i < 6; i++) ram[SCORE + i] = table.charCodeAt(i); frames(3); }
  ram[DEMO] = 1; ram[OVER] = 0; setScore(0); ram[DAN] = 0; frames(10);
}

// 1. Every condition and the leaderboard parse, and the set names the cartridge.
{
  const { codes, boards } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.length === 1 && boards[0] === 0, 'the high-score leaderboard parses');
  expect(set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'High Score is a SCORE board, higher is better');
  ok(`all ${codes.length} achievements and ${boards.length} leaderboard parse`);
}

// 2. The listed hashes are the cartridge's and the programs' rcheevos hashes.
for (const [asset, hash] of Object.entries(HASHES)) {
  let file = null;
  try { file = assetPath(asset); } catch { /* not registered */ }
  if (!file) {
    let note = `${asset} is not registered in test/external-assets.json`;
    try { note = missingNote(asset); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: ${asset} hashes to the listed hash # SKIP ${note}`);
    continue;
  }
  expect(set.hashes.some((h) => h.hash === hash), `the set lists ${hash}`);
  expect(rc.hash(fs.readFileSync(file)) === hash, `${path.basename(file)} hashes to ${hash}`);
  ok(`${asset} hashes to the listed hash`);
}

// 3. The demo unlocks nothing, starts no attempt and submits nothing.
{
  activate(); demo(); demo();
  expect(unlocked.size === 0 && started() === 0 && !submitted().length, `the demo counts for nothing (got ${[...unlocked]})`);
  ok('the attract demo is not a game');
}

// 4. Two-player games count for nothing, even after a one-player game.
{
  activate(); newGame(true); winContest(); winContest(); winContest(); setScore(60000); frames(5); loseContest();
  expect(unlocked.size === 0 && started() === 0, `a two-player game counts for nothing (got ${[...unlocked]})`);

  activate(); newGame(); loseContest(); newGame(true); winContest(); winContest(); setScore(60000); frames(5);
  expect(unlocked.size === 0, `an earlier one-player game does not open a two-player one (got ${[...unlocked]})`);
  ok('two players are kept out');
}

// 5. A trophy for every dan, 1st to 10th, two contests each.
{
  activate(); newGame();
  const at = { 1: 'White Belt No More', 2: 'Second Dan', 3: 'Third Dan', 4: 'Fourth Dan', 5: 'Fifth Dan', 6: 'Sixth Dan', 7: 'Seventh Dan', 8: 'Eighth Dan', 9: 'Ninth Dan', 10: 'Tenth Dan' };
  for (let d = 1; d <= 10; d++) {
    winContest(1, 100);
    if (at[d]) expect(!has(at[d]), `${at[d]} not after one contest`);
    winContest(1, 100);
    if (at[d]) expect(has(at[d]), `${at[d]} at dan ${d}`);
  }
  expect(!has('Unblemished'), 'every contest conceded a half point');
  expect(set.achievements.every((x, i) => x.id === i + 1), 'the trophies are numbered in their order');
  ok('dans');
}

// 6. Unblemished: a contest won while the computer has no half point, whether it brings a dan or not.
{
  activate(); newGame(); winContest(2); winContest(0);
  expect(has('Unblemished'), 'Unblemished on the contest that brings 1st dan');
  activate(); newGame(); winContest(0);
  expect(has('Unblemished') && !has('White Belt No More'), 'Unblemished on the first contest');
  ok('Unblemished');
}

// 7. The bull: beaten is $C2 = $80; hit by it is $C2 = 1.
{
  activate(); newGame(); ram[BULL] = 1; frames(3); ram[BULL] = 0; frames(3);
  expect(!has('Matador'), 'being hit by the bull is no win');
  ram[BULL] = 0x80; frames(2);
  expect(has('Matador'), 'Bull Fighter when the bull is beaten');
  ok('Matador');
}

// 8. Score tiers on the screen digits, and the rank text drawn over them is not a score.
{
  activate(); newGame();
  for (const [t, pts] of [['Rising Star', 10000], ['Exploding Fist', 25000], ['Grand Master', 50000]]) {
    setScore(pts - 100); frames(2);
    expect(!has(t), `${t}: ${pts - 100} is short`);
    setScore(pts); frames(2);
    expect(has(t), `${t} at ${pts}`);
  }
  activate(); newGame(); setScore(9900); frames(2);
  ram.set([0x4e, 0x4f, 0x56], SCORE + 3); frames(2);          // "NOV" over the hundreds
  expect(!has('Rising Star'), 'letters over the digits are not points');
  ok('score tiers');
}

// 9. High Score: the score as the lost contest ends, before the high-score table is drawn over it.
{
  activate(); newGame();
  expect(started() === 1, 'a one-player game starts the attempt');
  winContest(1, 4500); winContest(0, 3000);
  for (const [me, cpu] of [[0, 0], [2, 2], [0, 1]]) { ram[HALF] = me; ram[CPU_HALF] = cpu; ram[OVER] = 1; frames(2); ram[OVER] = 0; ram[HALF] = 0; ram[CPU_HALF] = 0; frames(2); }
  expect(!submitted().length, 'nothing is submitted while the game goes on, stops in a contest included');
  loseContest();
  const s = submitted();
  expect(s.length === 1 && s[0].value === 7500, `game over submits 7,500 (got ${s.map((e) => e.value)})`);
  demo();
  expect(submitted().length === 1, 'the demo submits nothing more');
  newGame();
  expect(started() === 2, 'the next game starts a new attempt');

  for (const [row, what] of [['   NOV', 'letters'], ['  10TH', 'digits']]) {
    activate(); newGame(); winContest(1, 2000); winContest(0, 3500); loseContest(row);
    const t = submitted();
    expect(t.length === 1 && t[0].value === 5500, `the table drawn over the score (${what}) does not change what is submitted (got ${t.map((e) => e.value)})`);
  }
  activate(); newGame(); winContest(1, 500); loseContest('   NOV', [2, 2]);
  expect(submitted().length === 1 && submitted()[0].value === 500, `a contest lost level on half points (the judges' call) submits too (got ${submitted().map((e) => e.value)})`);
  activate(); newGame(); setScore(1500); frames(3); ram[CPU_HALF] = 4; frames(5); ram[DEMO] = 1; setScore(0); frames(5);
  expect(submitted().length === 1 && submitted()[0].value === 1500, `with no contest end seen, game over still submits (got ${submitted().map((e) => e.value)})`);

  activate(); newGame(); loseContest('   NOV');
  expect(started() === 1 && !submitted().length, 'a pointless game submits nothing');
  ok('High Score start, submit and value');
}

// Unblemished is a challenge: live in a contest while the computer has no half point, out when it scores one.
{
  activate(); demo();
  expect(!primed.has(id.Unblemished), 'not live in the title demo');
  newGame();
  expect(primed.has(id.Unblemished), 'live as a game starts');
  ram[CPU_HALF] = 1; frames(3);
  expect(!primed.has(id.Unblemished) && !has('Unblemished'), 'out when the computer scores');
  winContest(1);
  expect(!has('Unblemished') && primed.has(id.Unblemished), 'live again in the next contest');
  winContest(0);
  expect(has('Unblemished'), 'and earned by a clean contest');
  ok('Unblemished: live, out, and live again');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - exploding-fist set: ${testNo} checks`);
