// Spec tests for the ported Vegetables Deluxe high-score boards
// (server/sets/vegetables-deluxe.json, from c64-cheevos, MIT) under rcheevos,
// on synthesized RAM laid out as the set reads it: the IRQ vector's low byte
// $0314 ($8C on the title and menu, $95 or $AB while a game runs), game mode
// $08C9 (0 casual, 1 shopping, 2 classic, 3 countdown; casual has no board),
// the BCD score $51C4 (lowest pair) to $51C6, shown with two more zeros, and
// shuffles left $51CB, which goes to $FF when a game ends (in the same frame
// as the return to the menu).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { checkSet } from '../../server/games.mjs';

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/vegetables-deluxe.json'), 'utf8')), 'vegetables-deluxe.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const IRQ = 0x0314, MODE = 0x08c9, SCORE = 0x51c4, SHUFFLES = 0x51cb;
const MENU = 0x8c;
const BOARD = { 1: 'Shopping', 2: 'Classic', 3: 'Countdown' };
const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
/** The score as shown; the game keeps it in hundreds. */
function setScore(n) { n = Math.floor(n / 100); for (let i = 0; i < 3; i++) { ram[SCORE + i] = bcd(n % 100); n = Math.floor(n / 100); } }

const events = [];
function activate() {
  rc.clear(); events.length = 0; ram.fill(0);
  return set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
}
function frame() {
  for (const e of rc.doFrame(ram)) if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) events.push({ ...e });
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const of = (type) => events.filter((e) => e.type === type);
function menu(mode) { ram[IRQ] = MENU; ram[MODE] = mode; setScore(0); ram[SHUFFLES] = 0; frames(10); }
function start(irq = 0x95) { ram[IRQ] = irq; ram[SHUFFLES] = 1; frames(2); }
/** No moves and no shuffles left: shuffles to $FF and back to the menu at once. */
function gameOver() { ram[SHUFFLES] = 0xff; ram[IRQ] = MENU; frames(1); }

// 1. The three boards parse.
{
  const codes = activate();
  expect(codes.length === 3 && codes.every((c) => c === 0), `the three boards parse (codes ${codes})`);
  expect(set.leaderboards.every((l) => l.title.includes(BOARD[l.id])), 'boards 1-3 are Shopping, Classic and Countdown');
  expect(set.hashes.some((h) => h.hash === '5c1e2ae1e5f6cb8c0e96e62d894dd05a'), 'the set names c64cade\'s PRG');
  ok('the set parses');
}

// 2. Each mode's game goes to its own board, and game over submits the score.
for (const mode of [1, 2, 3]) {
  activate(); frames(3); menu(mode);
  start(mode === 2 ? 0xab : 0x95);
  const started = of(EVENT.LBOARD_STARTED).map((e) => e.id);
  expect(started.length === 1 && started[0] === mode, `${BOARD[mode]} starts board ${mode} only (started ${started})`);
  setScore(123400); frames(3);
  gameOver();
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].id === mode && sub[0].value === 123400, `game over submits 123,400 to ${BOARD[mode]} (got ${JSON.stringify(sub)})`);
  ok(`a ${BOARD[mode]} game`);
}

// 3. Casual has no board, and the menu itself starts nothing.
{
  activate(); frames(3); menu(0); frames(30);
  start(); setScore(5000); frames(3); gameOver();
  expect(events.length === 0, `a casual game starts and submits nothing (got ${events.map((e) => e.type)})`);
  ok('casual games are not tracked');
}

// 4. Quitting to the menu (pause, Q) with shuffles left cancels the attempt.
{
  activate(); frames(3); menu(2); start();
  setScore(9900); frames(3);
  ram[IRQ] = MENU; frames(2);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'a quit submits nothing');
  expect(of(EVENT.LBOARD_CANCELED).length === 1, 'a quit cancels the attempt');
  ok('quitting a game is not a game over');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - vegetables-deluxe set: ${testNo} checks`);
