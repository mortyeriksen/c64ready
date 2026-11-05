// Spec tests for the Commando Arcade achievement set (server/sets/commando-arcade.json, Nostalgia's
// arcade-faithful Commando on its EasyFlash cartridge and universal disk) under rcheevos, on synthesized RAM laid out
// as the game keeps it:
//   $0410 men (lives), BCD: 5 when a game starts; one less per death, and the game is over at 0.
//         The title shows none.
//   $04FF grenades: 5 at the start, one less per throw, more from a grenade box.
//   $04F3 area index: 0-7 for areas 1-8, +1 as the next area starts (then the map loops).
//   $80   the player's Y. The main loop ($09BB) ends the area when it reads $5A, the gate; then the
//         bonus, $80 set to $FF, and the end text ("BROKE THE 1ST AREA ...") for about ten seconds
//         before $04F3 is raised. An area counts as cleared as the end text starts: $80 from $5A to $FF.
//   $04F8/$04F9/$04FA score in BCD, low byte first, shown with "00" after.
//   $0E48 $CD in a plain game. Any trainer from the options menu (invincibility, unlimited
//         lives or grenades, a starting level, the level-skip key) patches it to $4C.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/commando-arcade.json'), 'utf8')), 'commando-arcade.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = '1227141266752c0c04608fac355c7a4e';
const DISK_HASH = '647a1b60d3024575ae23f342be37637e';
const MEN = 0x410, GRENADES = 0x4ff, AREA = 0x4f3, SCORE = 0x4f8, TRAINER = 0xe48, PLAYER_Y = 0x80;

/** The score: shown / 100 in six BCD digits, low byte first. */
function setScore(shown) {
  const d = String(shown / 100).padStart(6, '0');
  ram[SCORE] = parseInt(d.slice(4, 6), 16); ram[SCORE + 1] = parseInt(d.slice(2, 4), 16); ram[SCORE + 2] = parseInt(d.slice(0, 2), 16);
}
const scoreNow = () => Number([2, 1, 0].map((i) => ram[SCORE + i].toString(16).padStart(2, '0')).join('')) * 100;
const unlocked = new Set();
const primed = new Set();   // challenges that can still be earned (rcheevos PRIMED, until UNPRIMED)
const lb = [];
function activate() {
  rc.clear(); unlocked.clear(); primed.clear(); lb.length = 0; ram.fill(0); ram[TRAINER] = 0xcd;
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
const started = (board = 1) => lb.filter((e) => e.type === EVENT.LBOARD_STARTED && e.id === board).length;
const submitted = (board = 1) => lb.filter((e) => e.type === EVENT.LBOARD_TRIGGERED && e.id === board);
const canceled = (board = 1) => lb.filter((e) => e.type === EVENT.LBOARD_CANCELED && e.id === board).length;
const has = (title) => unlocked.has(id[title]);

/** The title and attract screens: no men, the last game's area and score left over. */
function title() { ram[MEN] = 0; frames(10); }
/** A game: area index (0 = area 1), score and grenades set as the men go 0 to 5. With a trainer, $0E48 is patched. */
function start({ trainer = false, area = 0 } = {}) {
  ram[TRAINER] = trainer ? 0x4c : 0xcd;
  ram[AREA] = area; setScore(0); ram[GRENADES] = 5; ram[MEN] = 5; ram[PLAYER_Y] = 0xa3; frames(10);
}
/** The gate: the player's Y at $5A, then $FF as the end text starts; the next area starts after it, the player walking in from $B4. */
function reachGate() { ram[PLAYER_Y] = 0x5a; frames(2); ram[PLAYER_Y] = 0xff; frames(10); }
function nextArea() { frames(500); ram[AREA]++; ram[PLAYER_Y] = 0xb4; frames(10); ram[PLAYER_Y] = 0xa3; frames(5); }
function clearArea() { reachGate(); nextArea(); }
function die() { ram[MEN] = ram[MEN] === 0x10 ? 0x09 : ram[MEN] - 1; frames(10); }

// 1. Every condition and the leaderboard parse, and the set names both formats.
{
  const { codes, boards } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.length === 2 && boards.every((c) => c === 0), 'the high-score and area 1 speedrun boards parse');
  expect(set.leaderboards[1].format === 'MILLISECS' && set.leaderboards[1].lowerIsBetter, 'the speedrun is a time, lower is better');
  expect(rc.activateAchievement(999, set.gameOver) === 0, 'the game over parses'); rc.deactivateAchievement(999);
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names CommandoArcade_N0S_EF.crt');
  expect(set.hashes.some((h) => h.hash === DISK_HASH), 'the set names CommandoArcade_N0S_FL_Universal.d64');
  expect(set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'High Score is a SCORE board, higher is better');
  ok(`all ${codes.length} achievements and ${boards.length} leaderboard parse`);
}

// 2. The universal disk's listed hash is the hash of its file bytes.
{
  const file = assetPath('commando-arcade-d64');
  if (!file) console.log(`ok  - test ${++testNo}: the universal disk hashes to the listed hash # SKIP ${missingNote('commando-arcade-d64')}`);
  else { expect(rc.hash(fs.readFileSync(file)) === DISK_HASH, `${path.basename(file)} hashes to ${DISK_HASH}`); ok('the universal disk hashes to the listed hash'); }
}

// 3. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('commando-arcade-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'commando-arcade-crt is not registered in test/external-assets.json';
    try { note = missingNote('commando-arcade-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the EasyFlash cartridge hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the EasyFlash cartridge hashes to the listed hash'); }
}

// 4. The title and a game's own start (grenades and men set) unlock nothing.
{
  activate(); title(); ram[GRENADES] = 9; ram[AREA] = 5; setScore(200000); frames(10); setScore(0); ram[AREA] = 0;
  start();
  expect(unlocked.size === 0, `nothing on the title or at the start (got ${[...unlocked]})`);
  expect(started() === 1, 'the start begins an attempt');
  ok('title and start');
}

// 5. A game with a trainer counts for nothing, nor does one from a later starting level.
{
  activate(); title(); start({ trainer: true }); clearArea(); ram[GRENADES] = 9; frames(2); setScore(150000); frames(2); ram[MEN] = 0; frames(5);
  expect(unlocked.size === 0 && started() === 0 && !submitted().length, `a trainer game counts for nothing (got ${[...unlocked]})`);
  activate(); title(); start(); setScore(1000); frames(2); ram[MEN] = 0; frames(5);
  title(); start({ trainer: true }); clearArea(); frames(2);
  expect(!has('Off the Truck'), 'an earlier plain game does not open a later trainer game');
  activate(); title(); start({ trainer: true, area: 3 }); clearArea();
  expect(!has('Area 4 Cleared'), 'a starting level is a trainer too');
  ok('trainers are kept out');
}

// 6. Areas 1 to 8.
{
  activate(); title(); start();
  const area = (n) => (n === 1 ? 'Off the Truck' : n === 8 ? 'Full Circle' : `Area ${n} Cleared`);
  for (let n = 1; n <= 8; n++) {
    expect(!has(area(n)), `area ${n} not yet`);
    clearArea();
    expect(has(area(n)), `area ${n} cleared`);
  }
  expect(has('Untouchable'), 'no man lost in area 1');
  ok('areas');
}

// 7. Untouchable needs area 1 without a death.
{
  activate(); title(); start(); die(); clearArea();
  expect(has('Off the Truck') && !has('Untouchable'), 'a death in area 1 rules it out');
  ok('Untouchable');
}

// 8. Grenades: a box adds some, a throw takes one.
{
  activate(); title(); start();
  ram[GRENADES] = 4; frames(2);
  expect(!has('Grenadier'), 'a throw is no pickup');
  ram[GRENADES] = 7; frames(2);
  expect(has('Grenadier'), 'Grenadier for a box');
  ok('Grenadier');
}

// 9. Score tiers, in hundreds.
{
  activate(); title(); start();
  for (const [t, pts] of [['Super Joe', 10000], ['Front Line', 25000], ['Field Marshal', 50000], ['War Hero', 100000]]) {
    setScore(pts - 100); frames(2);
    expect(!has(t), `${t}: ${pts - 100} is short`);
    setScore(pts); frames(2);
    expect(has(t), `${t} at ${pts}`);
  }
  ok('score tiers');
}

// 10. High Score: submitted when the last man goes.
{
  activate(); title(); start();
  setScore(4500); frames(2); die(); die();
  expect(!submitted().length, 'deaths with men left submit nothing');
  setScore(12300); frames(2);
  ram[MEN] = 1; frames(2); ram[MEN] = 0; frames(2);
  const s = submitted();
  expect(s.length === 1 && s[0].value === 12300, `game over submits 12,300 (got ${s.map((e) => e.value)})`);
  title();
  expect(submitted().length === 1, 'the title submits nothing more');
  start();
  expect(started() === 2, 'the next game starts a new attempt');

  activate(); title(); start(); ram[MEN] = 0; frames(5);
  expect(started() === 1 && !submitted().length, 'a pointless game submits nothing');
  expect(scoreNow() === 0, 'score helper reads back');
  ok('High Score start, submit and value');
}

// The trainer notice: shown in a game started with a trainer, never in a plain one.
{
  const NOTICE = 1_000_000_000 + 1;
  const notice = set.notices?.[0];
  expect(notice && /trainer/i.test(notice.text) && rc.activateAchievement(NOTICE, notice.memaddr) === 0, 'the set has a trainer notice that parses');
  const fired = () => [...unlocked].includes(NOTICE);
  activate(); rc.activateAchievement(NOTICE, notice.memaddr);
  title(); start(); frames(20);
  expect(!fired(), 'a plain game shows no notice');
  activate(); rc.activateAchievement(NOTICE, notice.memaddr);
  title(); start({ trainer: true }); frames(5);
  expect(fired(), 'a game started with a trainer shows it');
  activate(); rc.activateAchievement(NOTICE, notice.memaddr);
  ram[TRAINER] = 0x4c; title();
  expect(!fired(), 'not on the title, with no game on');
  ok('the trainer notice');
}

// Untouchable is a challenge: live in area 1 with every man, out when one is lost.
{
  activate(); title();
  expect(!primed.has(id.Untouchable), 'not live on the title');
  start();
  expect(primed.has(id.Untouchable), 'live as area 1 starts');
  die();
  expect(!primed.has(id.Untouchable) && !has('Untouchable'), 'out when a man is lost');
  title(); start();
  expect(primed.has(id.Untouchable), 'live again in a new game');
  clearArea();
  expect(has('Untouchable'), 'and earned by clearing area 1');
  ok('Untouchable: live, out, and live again');
}

// The area 1 speedrun: from a new game to area 1 cleared, in hundredths (2 a PAL frame). A lost man goes
// on; game over or a trainer cancels it, and a trainer's game starts none.
{
  activate(); title(); start(); frames(2990); clearArea();
  expect(submitted(2).length === 1 && Math.abs(submitted(2)[0].value - 6000) <= 30, `a minute in area 1 posts about 1:00.00 (${submitted(2).map((e) => e.value)})`);
  clearArea();
  expect(submitted(2).length === 1, 'area 2 posts nothing more');

  activate(); title(); start(); frames(500); die(); frames(500); clearArea();
  expect(submitted(2).length === 1, 'a lost man does not stop the run');

  activate(); title(); start(); frames(500); ram[MEN] = 1; frames(5); ram[MEN] = 0; frames(10);
  expect(!submitted(2).length && canceled(2) === 1, 'game over cancels it');
  title(); start(); frames(990); clearArea();
  expect(submitted(2).length === 1 && Math.abs(submitted(2)[0].value - 2000) <= 30, `the next game runs from its own start (${submitted(2).map((e) => e.value)})`);

  activate(); title(); start({ trainer: true }); frames(500); clearArea();
  expect(!started(2) && !submitted(2).length, 'a game with a trainer starts no run');
  activate(); title(); start(); frames(500); ram[TRAINER] = 0x4c; frames(5); clearArea();
  expect(canceled(2) === 1 && !submitted(2).length, 'a trainer turned on mid-run cancels it');
  ok('the area 1 speedrun board');
}

// The end text, not the next area: the trophy unlocks and the speedrun stops as "BROKE THE 1ST AREA"
// starts, ten seconds before area 2. The player's Y leaving the screen ($FF) any other way is nothing.
{
  activate(); title(); start(); frames(1000);
  ram[PLAYER_Y] = 0xff; frames(10); ram[PLAYER_Y] = 0xa3; frames(10);
  expect(!has('Off the Truck') && !submitted(2).length, 'the player gone from the screen without the gate clears nothing');
  reachGate();
  expect(has('Off the Truck') && has('Untouchable'), 'area 1 is cleared as its end text starts');
  expect(submitted(2).length === 1 && Math.abs(submitted(2)[0].value - 2048) <= 30, `the speedrun stops there (${submitted(2).map((e) => e.value)})`);
  expect(ram[AREA] === 0 && !has('Area 2 Cleared'), 'before the area byte is raised');
  nextArea();
  expect(!has('Area 2 Cleared') && submitted(2).length === 1, 'and area 2 starting adds nothing');
  ok('an area is cleared as its end text starts');
}

// The game over: the last man lost, not an area cleared, so attract mode waits for the real end.
{
  let overs = 0;
  const run = (n) => { for (let i = 0; i < n; i++) for (const e of rc.doFrame(ram)) if (e.type === EVENT.ACHIEVEMENT_TRIGGERED && e.id === 999) overs++; };
  rc.clear(); ram.fill(0); ram[TRAINER] = 0xcd; rc.activateAchievement(999, set.gameOver); run(10);
  ram[AREA] = 0; setScore(0); ram[MEN] = 5; run(10); ram[AREA] = 1; run(10); ram[MEN] = 4; run(10);
  expect(overs === 0, 'not at an area cleared, nor at a lost man with more left');
  ram[MEN] = 1; run(5); ram[MEN] = 0; run(10);
  expect(overs === 1, 'the last man lost is the game over');
  ok('the game over');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - commando-arcade set: ${testNo} checks`);
