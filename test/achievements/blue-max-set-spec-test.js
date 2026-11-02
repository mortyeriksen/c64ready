// Spec tests for the Blue Max achievement set (server/sets/blue-max.json, Synapse 1983, on the
// OneLoad64 v5 cartridge) under rcheevos, on synthesized RAM laid out as the game keeps it:
//   $5DA7/$5DA8 $6D $C1, the score routine's ADC $40C1, once the game is unpacked.
//   $4093 0 in a game the player started (F7 or fire on the title), 1 in the attract demo.
//         F7 in a demo pauses it and clears this to 0, keeping the demo's flight.
//   $0F80 'F' while the flight HUD shows FUEL. A game's start writes it, with the score at 0.
//   $0F89 'C' once the game is over and the HUD shows the rank's CLASS. Blank in flight.
//   $40BE-$40C1 the score, one decimal digit per byte, 10,000s first, in tens (the ones always 0).
//   $4060 bombs, 30 at the start.
//   $4073 special targets bombed. $4075 special targets left, 8 or 9 at the start.
//   $408E the rank at the end: 0 Kamikaze Trainee, 1 Runway Sweeper, 2 Air Cadet,
//         3 Flying Tiger, 4 Squadron Leader, 5 Blue Max. It keeps its value into the next game.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/blue-max.json'), 'utf8')), 'blue-max.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'c42cd2ab88300117ea2c4e307c6e3be3';
const DEMO = 0x4093, HUD_F = 0x0f80, HUD_C = 0x0f89, SCORE = 0x40be, BOMBS = 0x4060, HITS = 0x4073, LEFT = 0x4075, RANK = 0x408e;
const F = 0x46, C = 0x43;

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
  const s = String(n / 10).padStart(4, '0');
  for (let i = 0; i < 4; i++) ram[SCORE + i] = s.charCodeAt(i) - 48;
}
function unpacked() { ram[0x5da7] = 0x6d; ram[0x5da8] = 0xc1; }

/** The title after an earlier game: the last rank and score still in RAM, no flight HUD. */
function title(lastRank = 1) {
  activate();
  unpacked();
  ram[DEMO] = 0; ram[HUD_F] = 0x4e; ram[HUD_C] = C; ram[RANK] = lastRank; ram[LEFT] = 7; ram[HITS] = 2; ram[BOMBS] = 12;
  score(560);
  frames(2);
}

/** A game started from the title: the HUD comes up, score 0, 30 bombs, nothing bombed. */
function begin(lastRank = 1) {
  title(lastRank);
  score(0); ram[HITS] = 0; ram[LEFT] = 8; ram[BOMBS] = 30; ram[HUD_C] = 0x20; ram[HUD_F] = F;
  frames(2);
}

/** The game ends: the rank is set and the HUD shows it. */
function end(rank) { ram[RANK] = rank; ram[HUD_F] = 0x4e; ram[HUD_C] = C; frames(2); }

// 1. Every condition parses, and the set names the cartridge and its one score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.url === 'https://www.lemon64.com/game/blue-max', 'the set links the game on Lemon64');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE', 'one score board');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('blue-max-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'blue-max-crt is not registered in test/external-assets.json';
    try { note = missingNote('blue-max-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. Demo flights count for nothing: they start, score, bomb and end with a rank on their own.
{
  title();
  ram[DEMO] = 1; score(0); ram[HITS] = 0; ram[HUD_C] = 0x20; ram[HUD_F] = F; frames(2);
  score(5000); ram[HITS] = 5; ram[LEFT] = 0; frames(2);
  end(5);
  expectNames('demo', []);
  expect(starts().length === 0 && submits().length === 0, 'a demo neither starts nor posts the score');
  ok('the attract demo unlocks nothing and posts nothing');
}

// 4. A demo taken over with F7 keeps its flight but is not a game the player started.
{
  begin();
  score(30); frames(2);
  expectNames('a real game first', ['Contact!']);
  end(0);
  ram[DEMO] = 1; score(0); ram[HITS] = 0; ram[HUD_C] = 0x20; ram[HUD_F] = F; frames(2);
  score(400); frames(2);
  ram[DEMO] = 0; frames(2);
  score(1000); ram[HITS] = 1; frames(2);
  expectNames('taken-over demo', ['Contact!']);
  expect(starts().length === 1, 'the takeover does not start the board');
  ok('a demo taken over with F7 counts for nothing');
}

// 5. Score tiers, and 500 with every bomb still aboard.
{
  begin();
  score(10); frames(2);
  expectNames('10', ['Contact!']);
  score(490); frames(2);
  expectNames('490', ['Contact!']);
  ram[BOMBS] = 29; score(500); frames(2);
  expectNames('500, one bomb gone', ['Contact!', 'Marksman']);
  score(1000); frames(2);
  score(2500); frames(2);
  score(5000); frames(2);
  expectNames('5,000', ['Air Superiority', 'Bombardier', 'Contact!', 'Marksman', 'Strafing Run']);
  score(10000); frames(2);
  expectNames('10,000', ['Air Superiority', 'Bombardier', 'Contact!', 'Marksman', 'Strafing Run', 'War Hero']);
  begin();
  score(500); frames(2);
  expectNames('500 with 30 bombs', ['Contact!', 'Bombs? Who Needs Bombs?', 'Marksman']);
  ok('score tiers and Full Load');
}

// 6. Special targets: one, three, five, and the last one left.
{
  begin();
  ram[HITS] = 1; ram[LEFT] = 7; frames(2);
  expectNames('one', ['Special Delivery']);
  ram[HITS] = 3; ram[LEFT] = 5; frames(2);
  expectNames('three', ['Special Delivery', 'Three of a Kind']);
  ram[HITS] = 5; ram[LEFT] = 3; frames(2);
  expectNames('five', ['High Five', 'Special Delivery', 'Three of a Kind']);
  ram[HITS] = 8; ram[LEFT] = 0; frames(2);
  expectNames('all', ['Clean Sweep', 'High Five', 'Special Delivery', 'Three of a Kind']);
  ok('special targets');
}

// 7. Ranks count when a game ends, from the rank it ends with. The last game's rank does not count again.
{
  begin(4);
  score(50); frames(4);
  expectNames('in flight, last rank 4', ['Contact!']);
  end(0);
  expectNames('Kamikaze Trainee', ['Contact!']);
  begin();
  score(560); frames(2);
  end(1);
  expectNames('Runway Sweeper', ['Contact!', 'Marksman', 'Bombs? Who Needs Bombs?', 'Runway Sweeper']);
  begin();
  end(3);
  expectNames('Flying Tiger', ['Air Cadet', 'Flying Tiger', 'Runway Sweeper']);
  begin();
  end(5);
  expectNames('The Blue Max', ['Air Cadet', 'The Blue Max', 'Flying Tiger', 'Runway Sweeper', 'Squadron Leader']);
  ok('ranks at the end of a game');
}

// 8. The score posts when the rank comes up, once, not at 0, and again for the next game.
{
  begin();
  score(140); frames(2);
  end(0);
  let posted = submits();
  expect(posted.length === 1 && posted[0].value === 140, `a 140 game posts 140 (got ${posted.map((e) => e.value).join(',') || 'nothing'})`);
  frames(4);
  expect(submits().length === 1, 'it posts once');
  ram[HUD_C] = 0x20; score(0); ram[HUD_F] = F; frames(2);
  expect(starts().length === 2, 'the next game starts the board again');
  end(0);
  expect(submits().length === 1, 'a game with no points posts nothing');
  ram[HUD_C] = 0x20; ram[HUD_F] = F; frames(2);
  score(560); frames(2);
  end(1);
  posted = submits();
  expect(posted.length === 2 && posted[1].value === 560, `the next game posts 560 (got ${posted.map((e) => e.value).join(',')})`);
  ok('the score posts at the end of a game');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Blue Max set: ${testNo} spec checks`);
