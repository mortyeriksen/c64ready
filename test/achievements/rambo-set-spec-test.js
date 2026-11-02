// Spec tests for the Rambo First Blood Part II achievement set (server/sets/rambo.json, Ocean 1985,
// on the OneLoad64 v5 cartridge) under rcheevos, on synthesized RAM laid out as the game keeps it:
//   $2462 $A2 and $0C89 $A5 once the game code is unpacked (the OneLoad stub has neither).
//   $2483-$2488 the score, one decimal digit per byte, 100000s first.
//   $0CC3 energy: 48 when a game starts, 7 less per hit, $FF when it runs out. The attract keeps 0.
//         A phase change refills it to 48, after points have been scored.
//   $19ED weapons carried: 7 at the start, +$08 the grenades, +$10 the machine gun.
//   $0AFF P.O.W.s freed on foot.
//   $0537 the message shown between phases: 1 task one completed, 2 the gunship is in pursuit,
//         3 game over, 4 congratulations (the mission). It keeps its value until the next one.
//   $22C2 1 while flying the helicopter. $E6 1 once it has landed at the camp.
//   $08EB 1 once Rambo is back at the helicopter with the prisoners.
//   $0F 0 in play, non-zero when the game ends. It also goes up while the mission message shows,
//       with $0537 already 4, and the game then plays on.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/rambo.json'), 'utf8')), 'rambo.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '75e3322eff562e80296d45397072fd00';
const CODE = 0x2462, CODE2 = 0x0c89, ENERGY = 0x0cc3, ARMS = 0x19ed, POW = 0x0aff, MSG = 0x0537;
const FLYING = 0x22c2, LANDED = 0xe6, RAID = 0x08eb, ENDED = 0x0f, SCORE = 0x2483;

const unlocked = new Set();
const boards = [];
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  for (const l of set.leaderboards ?? []) codes.push(rc.activateLeaderboard(l.id, l.definition));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const submits = () => boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
const starts = () => boards.filter((e) => e.type === EVENT.LBOARD_STARTED);

function score(n) {
  const s = String(n).padStart(6, '0');
  for (let i = 0; i < 6; i++) ram[SCORE + i] = s.charCodeAt(i) - 48;
}

/** The attract with the game code unpacked: energy 0, the last message still set. */
function attract(lastMsg = 3) {
  activate();
  ram[CODE] = 0xa2; ram[CODE2] = 0xa5;
  ram[ENERGY] = 0; ram[ARMS] = 7; ram[MSG] = lastMsg; ram[LANDED] = 0;
  score(0);
  frames(2);
}

/** A game just started from the attract: the bar filled, nothing scored, nothing found. */
function begin(lastMsg = 3) {
  attract(lastMsg);
  ram[ENERGY] = 48;
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge and its one score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.url === 'https://www.lemon64.com/game/rambo-first-blood-part-ii', 'the set links the game on Lemon64');
  expect(set.achievements.length >= 15, `at least 15 achievements (got ${set.achievements.length})`);
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE', 'one score board');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('rambo-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'rambo-crt is not registered in test/external-assets.json';
    try { note = missingNote('rambo-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The OneLoad stub and the attract unlock nothing and start nothing, however the bytes look.
{
  activate();
  ram[ENERGY] = 48; ram[ARMS] = 0xff; ram[POW] = 1; ram[MSG] = 4; ram[FLYING] = 1; ram[LANDED] = 1; ram[RAID] = 1;
  score(99900);
  frames(4);
  expectNames('stub', []);
  expect(starts().length === 0, 'the stub does not start the board');
  attract();
  ram[MSG] = 1; frames(2);
  ram[MSG] = 4; frames(2);
  expectNames('attract', []);
  expect(starts().length === 0, 'the attract does not start the board');
  ok('the stub and the attract unlock nothing');
}

// 4. A game counts from its own start. Bytes dressed as late play, with no start seen, count for nothing,
//    and a refill after points does not count as a start.
{
  attract();
  ram[ENERGY] = 30; score(8000); frames(2);
  ram[ENERGY] = 48; frames(2);
  ram[MSG] = 4; frames(2);
  expectNames('refill after points', []);
  expect(starts().length === 0, 'a refill after points does not start the board');
  begin();
  expectNames('start', []);
  expect(starts().length === 1 && submits().length === 0, 'the start starts the board once, with nothing to post');
  ok('the start of a game is the only way in');
}

// 5. Score tiers, and 5,000 before the first hit.
{
  begin();
  score(100); frames(2);
  expectNames('100', ['First Blood']);
  score(4900); frames(2);
  expectNames('4,900', ['First Blood']);
  score(5000); frames(2);
  expectNames('5,000 untouched', ['Clean Hands', 'First Blood']);
  score(10000); frames(2);
  expectNames('10,000', ['Clean Hands', 'First Blood', 'Jungle Fighter']);
  score(24900); frames(2);
  expectNames('24,900', ['Clean Hands', 'First Blood', 'Jungle Fighter']);
  score(25000); frames(2);
  expectNames('25,000', ['Clean Hands', 'First Blood', 'Jungle Fighter', 'One-Man Army']);
  score(50000); frames(2);
  expectNames('50,000', ['Clean Hands', 'First Blood', 'Jungle Fighter', 'Legend', 'One-Man Army']);
  begin();
  ram[ENERGY] = 41; frames(2);
  score(5000); frames(2);
  expectNames('5,000 after a hit', ['First Blood']);
  ok('score tiers, and Clean Hands only before the first hit');
}

// 6. Weapons: each new pickup, and both at once.
{
  begin();
  ram[ARMS] = 7 | 0x08; frames(2);
  expectNames('grenades', ['Pineapple Express']);
  ram[ARMS] = 7 | 0x18; frames(2);
  expectNames('both', ['Armed to the Teeth', 'Pineapple Express', 'Say Hello']);
  begin();
  ram[ARMS] = 7 | 0x10; frames(2);
  expectNames('machine gun', ['Say Hello']);
  ram[ARMS] = 7 | 0x30; frames(2);
  expectNames('rocket launcher too', ['Say Hello']);
  ok('the grenades, the machine gun, and both');
}

// 7. The mission in order: a prisoner, task one, take-off, the camp, the raid, the gunship, home.
{
  begin();
  score(5000); ram[POW] = 1; frames(2);
  expectNames('prisoner', ['Clean Hands', 'First Blood', 'Prisoner Found']);
  ram[ENERGY] = 34; frames(2);
  ram[MSG] = 1; frames(2);
  expectNames('task one', ['Clean Hands', 'First Blood', 'Prisoner Found', 'Task One']);
  ram[ENERGY] = 48; frames(2);
  ram[FLYING] = 1; frames(2);
  ram[LANDED] = 1; ram[FLYING] = 0; frames(2);
  ram[RAID] = 1; frames(2);
  ram[MSG] = 2; frames(2);
  expectNames('gunship', ['Camp Raid', 'Clean Hands', 'First Blood', 'Get to the Chopper', 'Unwanted Escort', 'Prisoner Found', 'Task One', 'Touchdown']);
  ram[MSG] = 4; score(105000); ram[ENDED] = 1; frames(2);
  expectNames('home', ['Camp Raid', 'Clean Hands', 'First Blood', 'Get to the Chopper', 'Unwanted Escort', 'Jungle Fighter', 'Legend', 'Mission Accomplished', 'One-Man Army', 'Prisoner Found', 'Task One', 'Touchdown']);
  expect(submits().length === 0, 'the mission message does not post the score');
  ok('the mission, step by step');
}

// 8. Task one with the bar full, or with one hit left. A message held from an earlier game does not count.
{
  begin();
  score(5000); ram[POW] = 1; frames(2);
  ram[MSG] = 1; frames(2);
  expectNames('full bar', ['Clean Hands', 'First Blood', 'Prisoner Found', 'Task One', 'Untouchable']);
  begin();
  ram[ENERGY] = 6; score(5000); ram[POW] = 1; frames(2);
  ram[MSG] = 1; frames(2);
  expectNames('one hit left', ['By a Thread', 'First Blood', 'Prisoner Found', 'Task One']);
  begin();
  ram[ENERGY] = 13; score(5000); ram[POW] = 1; frames(2);
  ram[MSG] = 1; frames(2);
  expectNames('two hits left', ['First Blood', 'Prisoner Found', 'Task One']);
  begin(4);
  score(100); frames(2);
  expectNames('the last game was won', ['First Blood']);
  ok('Untouchable and By a Thread');
}

// 9. The score posts when the game ends, once, and a second game in the session posts its own.
{
  begin();
  score(4600); ram[ENERGY] = 0; frames(2);
  ram[ENERGY] = 0xff; ram[ENDED] = 1; ram[MSG] = 3; frames(2);
  let posted = submits();
  expect(posted.length === 1 && posted[0].value === 4600, `a 4,600 game posts 4600 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);
  frames(4);
  expect(submits().length === 1, 'it posts once');
  ram[ENERGY] = 0; ram[ENDED] = 0; frames(2);
  score(0); ram[ENERGY] = 48; frames(2);
  expect(starts().length === 2, 'the next game starts the board again');
  score(1100); ram[ENERGY] = 0xff; ram[ENDED] = 1; frames(2);
  posted = submits();
  expect(posted.length === 2 && posted[1].value === 1100, `the next game posts 1100 (got ${posted.map((e) => e.value).join(',')})`);
  ok('the score posts at game over');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Rambo set: ${testNo} spec checks`);
