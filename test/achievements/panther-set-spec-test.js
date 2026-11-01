// Spec tests for the ported Panther high-score board (server/sets/panther.json,
// from c64-cheevos, MIT) under rcheevos, on synthesized RAM laid out as the
// Panther disassembly documents it: lives $10 (6 at the start of a run,
// 0 = game over), main loop running $26, game-over flag $27 (set when the last
// life is lost), score $842A-$8431 (one decimal digit 0-9 per byte, most
// significant first). While the cartridge loads, lives are 0 and the score
// bytes hold junk. F1 and RESTORE restart a game in progress without a game
// over: the abandoned score is not submitted, the restarted game's is.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/panther.json'), 'utf8')), 'panther.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const LIVES = 0x10, PLAYING = 0x26, GAME_OVER = 0x27, SCORE = 0x842a;
const CADE = '9188c8a20003ed2bc41c730e56731342', ONELOAD = '4ccefa158b62ef222e794ccc98717dc0';

function setScore(n) {
  const d = String(n).padStart(8, '0');
  for (let i = 0; i < 8; i++) ram[SCORE + i] = Number(d[i]);
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
/** Loading: lives 0, junk in the score bytes, main loop not running. */
function loading() { ram[LIVES] = 0; ram[PLAYING] = 0; ram[GAME_OVER] = 0; ram.set([0x20, 0x5b, 0xff, 0x58, 0x6c, 0, 0xa0, 0xa2], SCORE); frames(10); }
/** The new game setup: score cleared, 6 lives, main loop running. */
function newGame() { setScore(0); ram[LIVES] = 6; ram[GAME_OVER] = 0; ram[PLAYING] = 1; frames(2); }

// 1. The board parses and names both cartridges.
{
  const codes = activate();
  expect(codes.length === 1 && codes[0] === 0, `the high-score board parses (codes ${codes})`);
  expect(set.achievements.length === 0, 'the board only: c64-cheevos has no Panther achievements');
  expect(set.hashes.some((h) => h.hash === CADE), 'the set names c64cade\'s Panther.crt');
  expect(set.hashes.some((h) => h.hash === ONELOAD), 'the set names the OneLoad64 Panther.crt');
  ok('the set parses');
}

// 2. The listed OneLoad64 hash is the cartridge's rcheevos hash.
{
  const file = assetPath('panther-crt');
  if (!file) console.log(`ok  - test ${++testNo}: panther-crt hashes to the listed hash # SKIP ${missingNote('panther-crt')}`);
  else { expect(rc.hash(fs.readFileSync(file)) === ONELOAD, 'the OneLoad64 Panther.crt hashes to the listed MD5'); ok('panther-crt hashes to the listed hash'); }
}

// 3. Loading never starts an attempt.
{
  activate(); loading();
  setScore(0); frames(5);
  expect(kinds().length === 0, `nothing starts while loading (got ${kinds()})`);
  ok('nothing starts while the cartridge loads');
}

// 4. A run: 6 lives, score climbs, the last life submits it.
{
  activate(); loading(); newGame();
  expect(kinds()[0] === EVENT.LBOARD_STARTED, 'the new game setup starts the attempt');
  setScore(2000); ram[LIVES] = 3; frames(3);
  setScore(12340); ram[LIVES] = 1; frames(3);
  expect(!submitted().length, 'nothing is submitted while a life is left');
  ram[LIVES] = 0; ram[GAME_OVER] = 1; frames(1);
  expect(submitted().length === 1 && submitted()[0].value === 12340, `game over submits 12,340 (got ${submitted().map((e) => e.value)})`);
  // Fire on the game-over screen: a second game, which may already have lost a life.
  ram[PLAYING] = 0; frames(5);
  setScore(0); ram[LIVES] = 5; ram[GAME_OVER] = 0; ram[PLAYING] = 1; frames(2);
  expect(kinds().filter((k) => k === EVENT.LBOARD_STARTED).length === 2, 'the second game starts a new attempt');
  setScore(99999990); ram[LIVES] = 0; ram[GAME_OVER] = 1; frames(1);
  expect(submitted().length === 2 && submitted()[1].value === 99999990, `all eight digits count (got ${submitted().map((e) => e.value)})`);
  ok('a run starts with the new game and submits at game over');
}

// 5. F1 / RESTORE restart: the abandoned score is not submitted, the restarted game's is.
{
  activate(); loading(); newGame();
  setScore(4500); ram[LIVES] = 4; frames(3);
  setScore(0); ram[LIVES] = 6; frames(3);
  expect(!submitted().length, 'the restart submits nothing');
  setScore(1500); ram[LIVES] = 0; ram[GAME_OVER] = 1; frames(1);
  expect(submitted().length === 1 && submitted()[0].value === 1500, `the restarted game's 1,500 is submitted, not 4,500 (got ${submitted().map((e) => e.value)})`);
  ok('a restart drops the abandoned score');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - panther set: ${testNo} checks`);
