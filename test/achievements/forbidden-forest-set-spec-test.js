// Spec tests for the ported Forbidden Forest achievement set
// (server/sets/forbidden-forest.json, from c64-cheevos, MIT) under rcheevos, on
// synthesized RAM laid out as the set reads it: score $2A-$2D (BCD, low byte
// first), arrows $27, enemy wave $4E (1 spiders, 2 bees, 4 frogs, 8 dragons,
// $10 phantom, $20 snake, $40 Demogorgon, $80 once he falls), start timer $55
// (a game starts when it reads 1 with lives), lives $5F, difficulty $69
// (4 Innocent, 8 Trooper, $0C Daredevil, $10 Crazy). Kill requirements are the
// manual's: spiders 8/12/16, bees 2/3/4, frogs 12/16/20, dragons 1/2/3,
// phantom 1/1/2, snake 1/2/3, the Demogorgon 1 (Trooper/Daredevil/Crazy).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/forbidden-forest.json'), 'utf8')), 'forbidden-forest.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const ARROWS = 0x27, ENEMY = 0x4e, START = 0x55, LIVES = 0x5f, DIFF = 0x69, SCORE = 0x2a;
const INNOCENT = 4, TROOPER = 8, DAREDEVIL = 0x0c, CRAZY = 0x10;
const WAVES = [1, 2, 4, 8, 16, 32, 64];
const KILLS = { [TROOPER]: [8, 2, 12, 1, 1, 1, 1], [DAREDEVIL]: [12, 3, 16, 2, 1, 2, 1], [CRAZY]: [16, 4, 20, 3, 2, 3, 1] };

/** The score as the game keeps it: eight BCD digits, low byte first. */
function setScore(n) {
  const d = String(n).padStart(8, '0');
  for (let i = 0; i < 4; i++) ram[SCORE + i] = parseInt(d.slice(6 - 2 * i, 8 - 2 * i), 16);
}
const unlocked = new Set();
const lbEvents = [];
function activate() {
  rc.clear(); unlocked.clear(); lbEvents.length = 0;
  return {
    codes: set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr)),
    lb: set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition)),
  };
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) lbEvents.push({ ...e });
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
/** The title screen's RAM, then a game started on `diff`: lives 3, the start timer counting 4 to 1. */
function newGame(diff) {
  activate(); ram.fill(0);
  ram.set([0x00, 0x01, 0x08, 0x00], SCORE);   // the level-select screen's score bytes
  ram[DIFF] = 0x8d; frames(5);
  ram[DIFF] = diff; ram[LIVES] = 3; ram[ARROWS] = 50; ram[ENEMY] = 1; setScore(0);
  for (const t of [4, 3, 2, 1]) { ram[START] = t; frames(3); }
  ram[START] = 0; frames(2);
}
/** Fire `n` arrows (one load each) in the current wave. */
function shoot(n) { for (let i = 0; i < n; i++) { ram[ARROWS]--; frames(2); } }
/** The wave advance: lives back to 3, the next enemy, arrows refilled on Innocent/Trooper. */
function advance() {
  ram[LIVES] = 3;
  ram[ENEMY] = ram[ENEMY] === 0x40 ? 0x80 : ram[ENEMY] << 1;
  frames(3);
  if (ram[DIFF] <= TROOPER) ram[ARROWS] = 50;
  frames(2);
}
/** A wave cleared with `extra` arrows beyond its kill requirement. */
function clearWave(extra = 0) {
  const need = KILLS[ram[DIFF]]?.[WAVES.indexOf(ram[ENEMY])] ?? 1;
  shoot(need + extra);
  advance();
}

// 1. Every condition and the leaderboard parse; Quick Kill (VIC register) is left out.
{
  const { codes, lb } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(lb.every((c) => c === 0), 'the high-score leaderboard parses');
  expect(!('Quick Kill' in id), 'Quick Kill is not ported: night is only in a VIC register');
  ok(`all ${codes.length} achievements and ${lb.length} leaderboard parse`);
}

// 2. The listed files: the OneLoad64 cartridge hashes to its entry.
{
  const file = assetPath('forbidden-forest-crt');
  if (!file) console.log(`ok  - test ${++testNo}: the OneLoad64 cartridge hashes to the listed hash # SKIP ${missingNote('forbidden-forest-crt')}`);
  else {
    const h = rc.hash(fs.readFileSync(file));
    expect(set.hashes.some((x) => x.hash === h), `the OneLoad64 cartridge's hash ${h} is listed`);
    ok('the OneLoad64 cartridge hashes to the listed hash');
  }
}

// 3. The level-select screen and a game that never got going unlock nothing.
{
  activate(); ram.fill(0);
  ram.set([0x00, 0x01, 0x08, 0x00], SCORE); ram[DIFF] = 0x8d;
  frames(60);
  for (const e of [1, 2, 4, 8, 16, 32, 64, 128]) { ram[ENEMY] = e; frames(2); }
  expect(unlocked.size === 0, `no unlocks without a started game (got ${[...unlocked]})`);
  expect(!lbEvents.length, 'no leaderboard attempt without a started game');
  ok('nothing on the level-select screen, whatever the wave byte does');
}

// 4. The wave achievements, one per boss, on Trooper.
{
  newGame(TROOPER);
  const order = ['Arachnophobia', 'Bee Urself', 'Frogger not like this', 'Dragonbreed', 'Fantômas', 'Why did it have to be Snakes?', 'Demogorgon Party'];
  order.forEach((t, i) => {
    expect(!unlocked.has(id[t]), `${t} not before its wave ends`);
    clearWave(1);   // one arrow wasted per wave: no Perfect or One Shot
    expect(unlocked.has(id[t]), `${t} when wave ${i + 1} is cleared`);
  });
  for (const t of ['Perfect Spiders', 'Perfect Bees', 'Perfect Frogs', 'Perfect Dragons', 'One Shot Phantom', 'One Shot Snake', 'One Shot Demogorgon']) {
    expect(!unlocked.has(id[t]), `not ${t}: an arrow was wasted`);
  }
  expect(!unlocked.has(id['Ultimate Master']), 'not Ultimate Master: started on Trooper');
  ok('each wave clear on Trooper unlocks its boss achievement');
}

// 5. Innocent clears unlock none of the Trooper-or-higher achievements.
{
  newGame(INNOCENT);
  for (let i = 0; i < 7; i++) { shoot(1); advance(); }
  expect(unlocked.size === 0, `nothing on Innocent (got ${[...unlocked]})`);
  ok('Innocent wave clears do not count');
}

// 6. A continue (lives back from 0 with the start timer idle) is not a new game.
{
  newGame(TROOPER);
  ram[LIVES] = 0; frames(3);
  ram[LIVES] = 3; frames(3);
  clearWave(0);
  expect(!unlocked.has(id.Arachnophobia), 'no Arachnophobia after a continue');
  ok('a continue after game over earns nothing');
}

// 7. Perfect waves: exactly the kill requirement in arrows, on each difficulty.
for (const diff of [TROOPER, DAREDEVIL, CRAZY]) {
  newGame(diff);
  const perfect = ['Perfect Spiders', 'Perfect Bees', 'Perfect Frogs', 'Perfect Dragons', 'One Shot Phantom', 'One Shot Snake', 'One Shot Demogorgon'];
  for (const t of perfect) {
    const before = unlocked.has(id[t]);
    clearWave(0);
    expect(!before && unlocked.has(id[t]), `${t} on difficulty $${diff.toString(16)} with no arrow wasted`);
  }
  ok(`perfect waves on difficulty $${diff.toString(16)}`);
}

// 8. One arrow over the requirement in a wave loses that wave's perfect achievement only.
{
  newGame(DAREDEVIL);
  clearWave(1);
  expect(unlocked.has(id.Arachnophobia) && !unlocked.has(id['Perfect Spiders']), 'Perfect Spiders lost to a 13th arrow on Daredevil');
  clearWave(0);
  expect(unlocked.has(id['Perfect Bees']), 'the next wave starts a fresh count: Perfect Bees');
  ok('a wasted arrow counts against its own wave');
}

// 9. Ultimate Master: start on Innocent, clear every loop up to the Demogorgon on Crazy.
{
  newGame(INNOCENT);
  for (const diff of [INNOCENT, TROOPER, DAREDEVIL, CRAZY]) {
    ram[DIFF] = diff; frames(2);
    for (let i = 0; i < 7; i++) {
      if (diff === CRAZY && i === 6) expect(!unlocked.has(id['Ultimate Master']), 'not Ultimate Master before the Crazy Demogorgon falls');
      clearWave(1);
    }
    ram[ENEMY] = 1; frames(3);   // the next loop
  }
  expect(unlocked.has(id['Ultimate Master']), 'Ultimate Master when the Crazy Demogorgon falls in a game started on Innocent');
  ok('Ultimate Master');
}

// 10. Undead Slayer: five skeletons (1000 each) in the phantom wave, five arrows, no life lost.
{
  const toPhantom = () => { newGame(TROOPER); for (let i = 0; i < 3; i++) clearWave(1); setScore(30000); frames(2); clearWave(1); };
  const skeletons = (n, score) => { for (let i = 0; i < n; i++) { ram[ARROWS]--; frames(2); score += 1000; setScore(score); frames(2); } return score; };
  toPhantom();
  let s = skeletons(4, 30000);
  expect(!unlocked.has(id['Undead Slayer']), 'not at four skeletons');
  skeletons(1, s);
  expect(unlocked.has(id['Undead Slayer']), 'Undead Slayer at the fifth skeleton');

  toPhantom();
  s = skeletons(4, 30000); ram[ARROWS]--; frames(2); setScore(s + 6000); frames(2);
  expect(!unlocked.has(id['Undead Slayer']), 'not for four skeletons and the phantom');

  toPhantom(); setScore(37000); frames(2);   // the thousands carry into the ten-thousands
  skeletons(5, 37000);
  expect(unlocked.has(id['Undead Slayer']), 'Undead Slayer across a ten-thousands carry');

  toPhantom();
  ram[ARROWS]--; frames(2);                    // a miss
  skeletons(5, 30000);
  expect(!unlocked.has(id['Undead Slayer']), 'not with a sixth arrow spent');

  toPhantom();
  s = skeletons(2, 30000); ram[LIVES] = 2; frames(2); skeletons(3, s);
  expect(!unlocked.has(id['Undead Slayer']), 'not after losing a life in the wave');
  ok('Undead Slayer');
}

// 11. The high score: starts with the game, submits the BCD score when the last life goes.
{
  newGame(DAREDEVIL);
  expect(lbEvents.some((e) => e.type === EVENT.LBOARD_STARTED), 'the attempt starts with the game');
  setScore(12345670); frames(2);
  ram[LIVES] = 1; frames(2);
  ram[LIVES] = 0; frames(1);
  setScore(0); frames(2);                       // the game clears the score after game over
  const sub = lbEvents.find((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(sub && sub.value === 12345670, `game over submits the score (got ${sub?.value})`);
  ok('high score');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - forbidden-forest set: ${testNo} checks`);
