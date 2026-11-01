// Spec tests for the ported Road Runner high-score board
// (server/sets/road-runner.json, from c64-cheevos, MIT) under rcheevos, on
// synthesized RAM laid out as the Road Runner disassembly documents it: score
// $6B-$72 (one decimal digit 0-9 per byte, most significant first), lives $B5
// (5 at the start, 0 = game over), play-screen-off $EB ($00 while the play
// screen runs, $FF on the title and game-over screens), demo flag $8096
// (non-zero after power-on until the first title cycle ends). The title also
// holds 5 lives and a zero score, so only the play screen coming up starts a
// game.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/road-runner.json'), 'utf8')), 'road-runner.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const SCORE = 0x6b, LIVES = 0xb5, SCREEN_OFF = 0xeb, DEMO = 0x8096;
const HASH = '67d2234e9ae2dcae787a44c54527fd36';

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
/** The title: 5 lives, zero score, play screen off. */
function title(demo = 0) { setScore(0); ram[LIVES] = 5; ram[SCREEN_OFF] = 0xff; ram[DEMO] = demo; frames(10); }

// 1. The board parses and names the cartridge.
{
  const codes = activate();
  expect(codes.length === 1 && codes[0] === 0, `the high-score board parses (codes ${codes})`);
  expect(set.achievements.length === 0, 'the board only: c64-cheevos has no Road Runner achievements');
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the MultiLoad64 EasyFlash cartridge');
  ok('the set parses');
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  const file = assetPath('road-runner-crt');
  if (!file) console.log(`ok  - test ${++testNo}: road-runner-crt hashes to the listed hash # SKIP ${missingNote('road-runner-crt')}`);
  else { expect(rc.hash(fs.readFileSync(file)) === HASH, 'the EasyFlash Road Runner hashes to the listed MD5'); ok('road-runner-crt hashes to the listed hash'); }
}

// 3. The title's 5 lives and zero score start nothing, with or without the demo flag.
{
  activate(); title(2); title(0);
  ram[SCREEN_OFF] = 0; ram[DEMO] = 2; frames(5);
  expect(kinds().length === 0, `nothing starts on the title or with the demo flag set (got ${kinds()})`);
  ok('the title screen starts nothing');
}

// 4. A game: the play screen comes up, points, lives lost, game over submits.
{
  activate(); title();
  ram[SCREEN_OFF] = 0; frames(2);
  expect(kinds()[0] === EVENT.LBOARD_STARTED, 'the play screen with 5 lives and no score starts the attempt');
  setScore(580); ram[LIVES] = 4; frames(3);
  ram[SCREEN_OFF] = 0xff; frames(2); ram[SCREEN_OFF] = 0; frames(2);   // a screen change mid-game
  ram[LIVES] = 1; setScore(1230); frames(3);
  expect(!submitted().length, 'nothing is submitted while a life is left');
  ram[LIVES] = 0; frames(1);
  expect(submitted().length === 1 && submitted()[0].value === 1230, `the last life submits 1,230 (got ${submitted().map((e) => e.value)})`);
  // The game-over screen, then the title again, then a second game.
  ram[SCREEN_OFF] = 0xff; frames(5); title();
  ram[SCREEN_OFF] = 0; frames(2);
  setScore(12345670); ram[LIVES] = 0; frames(1);
  expect(submitted().length === 2 && submitted()[1].value === 12345670, `all eight digits count (got ${submitted().map((e) => e.value)})`);
  ok('a game starts with the play screen and submits at game over');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - road runner set: ${testNo} checks`);
