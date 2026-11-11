// When a new game starts (src/achievements/new-game.js), for the toasts
// waiting in the queue, which belong to the game before it.
//
//   1. The next attempt: the first leaderboard start after the game ended.
//      A game ends at the set's game over, or, for a set without one, when a
//      score is posted. A board starting mid-play, as a level's speedrun does,
//      is not a new game.
//   2. Another game loaded, or none: a change of the loaded game, by its id,
//      so a tape's second side, a file of its own, is the same game.
//   3. A reset machine.
//   Each is told once.
import { createNewGameWatch } from '../../src/achievements/new-game.js';

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

const watch = () => { const w = { n: 0 }; w.on = createNewGameWatch(() => w.n++); return w; };

// ── 1. The next attempt ──────────────────────────────────────────────────────
{
  const w = watch();
  w.on.gameChanged('commando');
  w.n = 0;
  w.on.leaderboard('started', true);
  w.on.leaderboard('updated', true);
  w.on.leaderboard('started', true);
  expect(w.n === 0, `boards starting during play are not a new game (${w.n})`);
  w.on.leaderboard('submitted', true);
  w.on.leaderboard('started', true);
  expect(w.n === 0, `a set with its own game over does not end at a posted score (${w.n})`);
  w.on.gameOver();
  w.on.leaderboard('updated', true);
  expect(w.n === 0, `the game over itself starts nothing (${w.n})`);
  w.on.leaderboard('started', true);
  expect(w.n === 1, `the first board to start after it is the next attempt (${w.n})`);
  w.on.leaderboard('started', true);
  expect(w.n === 1, `and the boards after that are its own (${w.n})`);

  const v = watch();
  v.on.gameChanged('uridium');
  v.n = 0;
  v.on.leaderboard('submitted', false);
  v.on.leaderboard('canceled', false);
  expect(v.n === 0, `a set without a game over ends at a posted score, and starts nothing yet (${v.n})`);
  v.on.leaderboard('started', false);
  expect(v.n === 1, `the next start is a new game (${v.n})`);
  v.on.leaderboard('started', false);
  expect(v.n === 1, `once (${v.n})`);
  ok('the next attempt after a game ends is a new game, a board starting mid-play is not');
}

// ── 2. Another game ──────────────────────────────────────────────────────────
{
  const w = watch();
  w.on.gameChanged('commando');
  expect(w.n === 1, `loading a game is a new game (${w.n})`);
  w.on.gameChanged('commando');
  expect(w.n === 1, `the same game again, such as its tape's second side, is not (${w.n})`);
  w.on.gameChanged('uridium');
  expect(w.n === 2, `another game is (${w.n})`);
  w.on.gameChanged(null);
  expect(w.n === 3, `and so is none (${w.n})`);
  w.on.gameChanged(null);
  expect(w.n === 3, `once (${w.n})`);
  w.on.gameOver();
  w.on.gameChanged('elite');
  w.on.leaderboard('started', true);
  expect(w.n === 4, `a new game takes the place of a pending next attempt (${w.n})`);
  ok('another game loaded, or none, is a new game');
}

// ── 3. A reset ───────────────────────────────────────────────────────────────
{
  const w = watch();
  w.on.gameChanged('commando');
  w.n = 0;
  w.on.reset();
  expect(w.n === 1, `a reset machine is a new game (${w.n})`);
  w.on.gameOver();
  w.on.reset();
  w.on.leaderboard('started', true);
  expect(w.n === 2, `once, with the attempt it ended already counted (${w.n})`);
  ok('a reset is a new game');
}

console.log(failing === 0 ? `\nok - new game: ${testNo} checks` : `\nFAILED - new game: ${failing} of ${testNo} checks`);
process.exit(failing === 0 ? 0 : 1);
