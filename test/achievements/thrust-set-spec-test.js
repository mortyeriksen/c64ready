// Spec tests for the ported Thrust high-score board (server/sets/thrust.json,
// from c64-cheevos, MIT) under rcheevos, on synthesized RAM laid out as the
// Thrust disassembly documents it: demo-mode flag $63 ($00 in a real game,
// $FF on the title, high-score and demo screens), score $0180-$0182 (BCD,
// lowest byte first, shown with a fixed trailing 0), fuel-empty flag $9402,
// lives $9403 (spare lives in BCD: a new game holds 3, losing the last one
// wraps to $99). start_new_game clears the demo flag, zeroes the score, sets
// 3 lives and clears the fuel flag. A game ends on the last life, on running
// out of fuel, or on RUN/STOP back to the title; an empty game is never
// submitted.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/thrust.json'), 'utf8')), 'thrust.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const DEMO = 0x63, SCORE = 0x180, FUEL_EMPTY = 0x9402, LIVES = 0x9403;
const HASH = '958404356aaf406ef2ea5babbcb917bb';

/** The shown score as the game stores it: shown / 10 in six BCD digits, low byte first. */
function setScore(shown) {
  const d = String(shown / 10).padStart(6, '0');
  for (let i = 0; i < 3; i++) ram[SCORE + i] = parseInt(d.slice(4 - 2 * i, 6 - 2 * i), 16);
}
const events = [];
function activate() {
  rc.clear(); events.length = 0; ram.fill(0);
  return set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
}
function frame() {
  for (const e of rc.doFrame(ram)) if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) events.push({ ...e });
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const kinds = () => events.filter((e) => e.type !== EVENT.LBOARD_UPDATED).map((e) => e.type);
const submitted = () => events.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
/** The title screen, then start_new_game. */
function title() { ram[DEMO] = 0xff; ram[LIVES] = 3; setScore(0); ram[FUEL_EMPTY] = 0; frames(10); }
function newGame() { ram[DEMO] = 0; setScore(0); ram[LIVES] = 3; ram[FUEL_EMPTY] = 0; frames(2); }

// 1. The board parses and names the cartridge.
{
  const codes = activate();
  expect(codes.length === 1 && codes[0] === 0, `the high-score board parses (codes ${codes})`);
  expect(set.achievements.length === 0, 'the board only: c64-cheevos has no Thrust achievements');
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 Thrust (J1) cartridge');
  ok('the set parses');
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  const file = assetPath('thrust-crt');
  if (!file) console.log(`ok  - test ${++testNo}: thrust-crt hashes to the listed hash # SKIP ${missingNote('thrust-crt')}`);
  else { expect(rc.hash(fs.readFileSync(file)) === HASH, 'Thrust (J1).crt hashes to the listed MD5'); ok('thrust-crt hashes to the listed hash'); }
}

// 3. Title, high-score and demo screens never start an attempt, even as the demo scores.
{
  activate(); title();
  setScore(7500); frames(20);
  ram[LIVES] = 0x99; frames(5);
  expect(kinds().length === 0, `no attempt with the demo flag set (got ${kinds()})`);
  ok('nothing starts while the demo flag is set');
}

// 4. A game ended by its last life submits the shown score.
{
  activate(); title(); newGame();
  expect(kinds()[0] === EVENT.LBOARD_STARTED, 'start_new_game starts the attempt');
  setScore(12350); ram[LIVES] = 2; frames(3); ram[LIVES] = 1; frames(3); ram[LIVES] = 0; frames(3);
  expect(!submitted().length, 'nothing is submitted while a life is left');
  ram[LIVES] = 0x99; frames(1);
  expect(submitted().length === 1 && submitted()[0].value === 12350, `the last life submits 12,350 (got ${submitted().map((e) => e.value)})`);
  ok('the last life ends the game and submits the score');
}

// 5. Running out of fuel ends the game with lives left.
{
  activate(); title(); newGame();
  setScore(9999990); frames(2);
  ram[FUEL_EMPTY] = 1; frames(1);
  expect(submitted().length === 1 && submitted()[0].value === 9999990, `out of fuel submits 9,999,990 (got ${submitted().map((e) => e.value)})`);
  ok('out of fuel ends the game and submits the score');
}

// 6. RUN/STOP back to the title ends the game too.
{
  activate(); title(); newGame();
  setScore(2400); frames(2);
  ram[DEMO] = 0xff; frames(1);
  expect(submitted().length === 1 && submitted()[0].value === 2400, `quitting submits 2,400 (got ${submitted().map((e) => e.value)})`);
  ok('RUN/STOP ends the game and submits the score');
}

// 7. A game that ends on 0 is never submitted: first boot runs start_new_game once, then shows the title.
{
  activate(); ram[LIVES] = 0xff; ram[FUEL_EMPTY] = 0xff; frames(5);
  newGame();
  ram[DEMO] = 0xff; frames(2);
  newGame(); ram[LIVES] = 0x99; frames(2);
  expect(!submitted().length, 'an empty game submits nothing');
  expect(kinds().filter((k) => k === EVENT.LBOARD_CANCELED).length === 2, 'each empty game is canceled');
  ok('an empty game is canceled, not submitted');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - thrust set: ${testNo} checks`);
