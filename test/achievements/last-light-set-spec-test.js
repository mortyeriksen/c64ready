// Spec tests for the Last Light set (server/sets/last-light.json) under rcheevos, on
// synthesized RAM laid out as the game's src/vars.asm defines it: the state $C000
// (0 title, 1 a run being set up, 2 play, 3 pause, 4 game over), the level $CF8D
// (one up at each great bell, so 1-4 are the districts after the Rooftops and 5 a
// whole lap), the sword $C034, the Order's type $CF0B (0 Shadowblade, 1 Ring
// Thrower, 2 Lantern Thief, 3 Bell Warden) and state $C3C1 (2 struck), the six
// ASCII score digits $CF8A and $C041-$C045, the four ASCII height digits $CF8B and
// $C046-$C048, the bells $CF8C, $C03F and $C040 (0-9 each), the letters $CF4C (a
// bit per district), lives $CE96 and night mode $CF4A.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/last-light.json'), 'utf8')), 'last-light.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const STATE = 0xc000, LEVEL = 0xcf8d, WEAPON = 0xc034, ORD_TYPE = 0xcf0b, ORD_STATE = 0xc3c1;
const SCORE_TOP = 0xcf8a, SCORE = 0xc041, HEIGHT_TOP = 0xcf8b, HEIGHT = 0xc046;
const BELLS_HUND = 0xcf8c, BELLS_TENS = 0xc03f, BELLS_ONES = 0xc040;
const LETTERS = 0xcf4c, LIVES = 0xce96, NIGHT = 0xcf4a, CHAIN_N = 0xcf47, CLEAN = 0xce95, STREAK = 0xcf1b;
const byTitle = Object.fromEntries(set.achievements.map((a) => [a.title, a]));

function setScore(n) {
  const d = String(n).padStart(6, '0');
  ram[SCORE_TOP] = 0x30 + Number(d[0]);
  for (let i = 0; i < 5; i++) ram[SCORE + i] = 0x30 + Number(d[i + 1]);
}
function setHeight(n) {
  const d = String(n).padStart(4, '0');
  ram[HEIGHT_TOP] = 0x30 + Number(d[0]);
  for (let i = 0; i < 3; i++) ram[HEIGHT + i] = 0x30 + Number(d[i + 1]);
}
function setBells(n) { ram[BELLS_HUND] = Math.floor(n / 100); ram[BELLS_TENS] = Math.floor(n / 10) % 10; ram[BELLS_ONES] = n % 10; }

const events = [];
function frame() { for (const e of rc.doFrame(ram)) events.push({ ...e }); }
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const unlocked = () => events.filter((e) => e.type === EVENT.ACHIEVEMENT_TRIGGERED).map((e) => e.id);
const has = (title) => unlocked().includes(byTitle[title].id);
const of = (type) => events.filter((e) => e.type === type);

/** Power-on RAM, achievements and boards active, and a run set up the way new_run does it. */
function start({ boards = false } = {}) {
  rc.clear(); events.length = 0; ram.fill(0);
  for (const a of set.achievements) rc.activateAchievement(a.id, a.memaddr);
  if (boards) for (const l of set.leaderboards) rc.activateLeaderboard(l.id, l.definition);
  frames(3);
  newRun();
}
function newRun() {
  ram[STATE] = 1; setScore(0); setHeight(0); setBells(0);
  ram[LEVEL] = 0; ram[WEAPON] = 0; ram[LIVES] = 1; ram[CLEAN] = 0; ram[CHAIN_N] = 0; ram[STREAK] = 0;
  frame();
  ram[STATE] = 2; frames(3);
}

// 1. The set parses: every achievement, the three boards and the game-over condition.
{
  rc.clear();
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  const lb = set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
  expect(codes.every((c) => c === 0), `every achievement parses (codes ${codes})`);
  expect(lb.length === 3 && lb.every((c) => c === 0), `the score, height and bells boards parse (codes ${lb})`);
  expect(set.achievements.map((a) => a.id).join() === set.achievements.map((_, i) => i + 1).join(), 'ids run 1 up in order');
  expect(typeof set.gameOver === 'string', 'the set says when a climb is over');
  ok('the set parses');
}

// 2. The listed hash is the release disk's.
for (const [key, label] of [['last-light-d64', 'the release disk']]) {
  const file = assetPath(key);
  if (!file) { console.log(`ok  - test ${++testNo}: ${key} hashes to a listed hash # SKIP ${missingNote(key)}`); continue; }
  const h = rc.hash(fs.readFileSync(file));
  expect(set.hashes.some((x) => x.hash === h), `${label} hashes to ${h}, which the set lists`);
  ok(`${key} hashes to a listed hash`);
}

// 3. Each district, the laps and the top level unlock as the level climbs, one each.
{
  start();
  const steps = [[1, 'Into the Cloisters'], [2, 'Clockwork Heart'], [3, 'Into the Storm'], [4, 'Among the Stars'],
    [5, 'Full Circle'], [10, 'Second Lap'], [15, 'Endless Stair']];
  for (let level = 1; level <= 15; level++) {
    ram[LEVEL] = level; frames(2);
    for (const [at, title] of steps) {
      if (at === level) expect(has(title), `${title} unlocks as the level reaches ${at}`);
      if (at > level) expect(!has(title), `${title} waits for level ${at} (at ${level})`);
    }
  }
  ok('a district, a lap and the top level each unlock as the level climbs');
}

// 4. A new run puts the level back to 0 with the state at 1: no district unlocks from the reset,
//    nor from the game-over screen to the next run's first frame.
{
  start();
  ram[LEVEL] = 4; frames(2); events.length = 0;
  ram[STATE] = 4; frames(3);
  ram[LEVEL] = 0; ram[STATE] = 2; frames(2);  // the game over to play in one frame, the level reset
  ram[LEVEL] = 5; ram[STATE] = 1; frames(1); ram[STATE] = 2; frames(2);
  expect(!has('Full Circle'), 'a level change across a state change unlocks nothing');
  ok('a run being set up unlocks nothing');
}

// 5. The pause unlocks nothing: the level, held in pause, counts once play resumes.
{
  start();
  ram[STATE] = 3; frames(2); ram[LEVEL] = 1; frames(2); ram[STATE] = 2; frames(2);
  expect(!has('Into the Cloisters'), 'a change seen across the pause does not count');
  ok('the pause unlocks nothing');
}

// 6. The first of each member of the Order struck down.
{
  start();
  ram[WEAPON] = 1; frames(2);
  expect(unlocked().length === 0, 'picking up the sword alone unlocks nothing');
  for (const [type, title] of [[0, 'Blade Against Blade'], [2, 'Stop, Thief!'], [1, 'Ring Breaker'], [3, "Warden's Fall"]]) {
    ram[ORD_TYPE] = type; ram[ORD_STATE] = 0; frames(2);
    expect(!has(title), `${title} waits for the strike`);
    ram[ORD_STATE] = 3; frames(2);
    if (type === 2) expect(!has(title), 'a Lantern Thief fleeing on its own (state 3) is no win');
    ram[ORD_STATE] = 2; frames(2);
    expect(has(title), `struck (state 2) as type ${type} unlocks ${title}`);
  }
  const others = set.achievements.filter((a) => ['Blade Against Blade', 'Stop, Thief!', 'Ring Breaker', "Warden's Fall"].includes(a.title));
  expect(others.every((a) => unlocked().filter((id) => id === a.id).length === 1), 'each unlocks once');
  ok('the first of each enemy struck down');
}

// 7. The bell trophies: five clean climbs, a chain of x4, 100 bells. A stride streak is none.
{
  start();
  for (let n = 1; n <= 4; n++) { ram[CLEAN] = n; frames(2); }
  ram[STREAK] = 40; ram[CHAIN_N] = 3; frames(2);
  expect(!has('Clean Climber') && !has('Bell Chain'), 'four clean climbs and a chain of x3 are not yet');
  expect(unlocked().length === 0, 'nor is a stride streak');
  ram[CLEAN] = 5; ram[CHAIN_N] = 4; frames(2);
  expect(has('Clean Climber') && has('Bell Chain'), 'the fifth clean climb and a chain of x4 unlock theirs');
  setBells(99); frames(2);
  expect(!has('A Hundred Bells'), '99 bells is not yet a hundred');
  setBells(100); frames(2);
  expect(has('A Hundred Bells'), 'the hundredth bell unlocks A Hundred Bells');
  ok('five clean climbs, a chain and 100 bells');
}

// 8. Sunna's letters and the ninth life.
{
  start();
  ram[LETTERS] = 0x04; frames(2);
  expect(unlocked().length === 0, 'one letter unlocks nothing');
  ram[LETTERS] = 0x1f; ram[LIVES] = 8; frames(2);
  expect(has('All Her Letters'), 'all five bits unlock All Her Letters');
  expect(!has('Nine Lives'), 'eight lives is not nine');
  ram[LIVES] = 9; frames(2);
  expect(has('Nine Lives'), 'the ninth life unlocks Nine Lives');
  ok("Sunna's letters and nine lives");
}

// 9. Night mode is a game of its own: nothing unlocks while it is on, a climb's boards are
//    cancelled when it is switched on, and its notice shows.
{
  start({ boards: true });
  rc.activateAchievement(900, set.notices[0].memaddr);
  frames(2);
  expect(!events.some((e) => e.type === EVENT.ACHIEVEMENT_TRIGGERED && e.id === 900), 'no notice with night mode off');
  ram[NIGHT] = 1; frames(2);
  expect(events.some((e) => e.type === EVENT.ACHIEVEMENT_TRIGGERED && e.id === 900), 'the notice shows as night mode goes on in play');
  expect(of(EVENT.LBOARD_CANCELED).length === 3, `night mode cancels the climb on all three boards (got ${of(EVENT.LBOARD_CANCELED).length})`);
  ram[LEVEL] = 1; ram[WEAPON] = 1; ram[ORD_TYPE] = 0; ram[ORD_STATE] = 2; setScore(100000); frames(2);
  expect(unlocked().filter((id) => id !== 900).length === 0, `nothing unlocks in night mode (got ${unlocked()})`);
  ram[STATE] = 4; frames(2);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'a night climb submits nothing');
  newRun(); frames(2);
  expect(of(EVENT.LBOARD_STARTED).length === 3, 'the next climb, still at night, starts the boards');
  ram[STATE] = 4; frames(2);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'and they are cancelled again, not submitted');
  ok('night mode counts nothing and says so');
}

// 10. The score trophies read the six ASCII digits, and each names its milestone.
{
  start();
  const milestones = set.achievements.filter((a) => a.score);
  expect(milestones.map((a) => a.score).join() === '10000,25000,50000,100000', 'milestones at 10,000, 25,000, 50,000 and 100,000');
  for (const a of milestones) {
    setScore(a.score - 5); frames(2);
    expect(!unlocked().includes(a.id), `${a.title} waits below ${a.score}`);
    setScore(a.score); frames(2);
    expect(unlocked().includes(a.id), `${a.score} points unlocks ${a.title}`);
  }
  ok('the score trophies');
}

// 11. The boards: a climb starts as play begins, submits score, height and bells at game over.
{
  start({ boards: true });
  expect(of(EVENT.LBOARD_STARTED).length === 3, `a run starting starts all three boards (got ${of(EVENT.LBOARD_STARTED).length})`);
  setScore(31020); setHeight(302); setBells(25); frames(5);
  ram[STATE] = 3; frames(3); ram[STATE] = 2; frames(3);
  expect(of(EVENT.LBOARD_STARTED).length === 3, 'coming back from the pause does not restart them');
  ram[STATE] = 4; frames(2);
  const sub = Object.fromEntries(of(EVENT.LBOARD_TRIGGERED).map((e) => [e.id, e.value]));
  expect(sub[1] === 31020, `the score board gets 31,020 (got ${sub[1]})`);
  expect(sub[2] === 302, `the height board gets 302 (got ${sub[2]})`);
  expect(sub[3] === 25, `the bells board gets 25 (got ${sub[3]})`);
  ok('the boards submit at game over');
}

// 12. The digits wrapped into the sixth place, and the highest height and bells.
{
  start({ boards: true });
  setScore(123456); setHeight(1234); setBells(108); frames(2);
  ram[STATE] = 4; frames(2);
  const sub = Object.fromEntries(of(EVENT.LBOARD_TRIGGERED).map((e) => [e.id, e.value]));
  expect(sub[1] === 123456 && sub[2] === 1234 && sub[3] === 108, `six score digits, four height digits, three bell digits (got ${JSON.stringify(sub)})`);
  ok('every digit counts');
}

// 13. The boot program and the title start nothing: the state stays 0 until GAME runs.
{
  rc.clear(); events.length = 0; ram.fill(0);
  for (const a of set.achievements) rc.activateAchievement(a.id, a.memaddr);
  for (const l of set.leaderboards) rc.activateLeaderboard(l.id, l.definition);
  frames(3);
  for (let i = 0; i < 40; i++) { ram[0xc800 + ((i * 97) & 0x7ff)] = (i * 37) & 0xff; ram[LEVEL] = i & 15; ram[LETTERS] = i; setScore(i * 2500); frames(1); }
  const acted = events.filter((e) => [EVENT.ACHIEVEMENT_TRIGGERED, EVENT.LBOARD_STARTED, EVENT.LBOARD_TRIGGERED].includes(e.type));
  expect(acted.length === 0, `nothing unlocks or starts with the state at 0 (got ${acted.map((e) => e.type)})`);
  ok('the boot program and the title start nothing');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Last Light set: ${testNo} checks`);
