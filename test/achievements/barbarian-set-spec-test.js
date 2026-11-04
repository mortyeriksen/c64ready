// Spec tests for the Barbarian achievement set (server/sets/barbarian.json,
// Palace 1987, both OneLoad64 v5 cartridges and four programs). Side 1 is
// practice. Side 2 is the duel against Drax. One set covers all six files.
//
// $BA is 128 on player selection. F7 starts a fight: $BA goes to 0 and $B9
// goes to 128. The demo holds both at 0. $BD is 0 for one player and 1 for
// two. Two player does not climb. $BE is the opponent, 0 through 7, and
// the demo holds 4. $93 and $94 are the two energies, 12 when full. A blow
// lowers $94. A decapitation sets $025C to 128 and $AF to 129 when the
// opponent loses his head. $AF is 128 when you fall.
// $BB is 128 only after Drax, and only side 2's code does that.
// Side 1's hit is the byte 214 at $872D. Side 2's is 214 at $8899. Each cart
// has only its own. Scores are five screen-code digits: side 1 at $B9B8,
// side 2 at $BB22. Digit 0 is 48.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/barbarian.json'), 'utf8')), 'barbarian.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASHES = {
  'barbarian-side1-crt': '039806153c01bfc2f4e52cd9dbe6105c',
  'barbarian-side2-crt': 'fe73fb7d7b0454648de2d8e32199f205',
  'barbarian-side1-crunched-prg': '1203baf8cd07417be8f54c593facdf53',
  'barbarian-side2-crunched-prg': '2ead313b7d5d55b523b179e7d6bb80f4',
  'barbarian-side1-uncrunched-prg': 'e66670d04b12db967967254b860fdc66',
  'barbarian-side2-uncrunched-prg': '3095e8b3043121071cf79a60285ebc4e',
};
const BA = 0xba, B9 = 0xb9, BD = 0xbd, BE = 0xbe, BB = 0xbb, AF = 0xaf;
const E1 = 0x93, E2 = 0x94, POSE = 0x68, HEAD = 0x25c;
const SIDE1 = 0x872d, SIDE2 = 0x8899;
const P1 = 0xb9b8, P2 = 0xbb22;
const PRACTICE = 1, DUEL = 2;

const unlocked = new Set();
const primed = new Set();   // challenges that can still be earned (rcheevos PRIMED, until UNPRIMED)
const boards = [];
function activate() {
  rc.clear(); unlocked.clear(); primed.clear(); boards.length = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  for (const l of set.leaderboards ?? []) codes.push(rc.activateLeaderboard(l.id, l.definition));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type === EVENT.ACHIEVEMENT_PRIMED) primed.add(e.id);
    else if (e.type === EVENT.ACHIEVEMENT_UNPRIMED) primed.delete(e.id);
    else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const fresh = () => { activate(); frames(2); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const of = (id, type) => boards.filter((e) => e.id === id && e.type === type);
const submits = (id) => of(id, EVENT.LBOARD_TRIGGERED);
const cancels = (id) => of(id, EVENT.LBOARD_CANCELED);

function digits(base, n) {
  const s = String(n).padStart(5, '0');
  for (let i = 0; i < 5; i++) ram[base + i] = 48 + Number(s[i]);
}
function quiet(base, bytes) { for (let i = 0; i < 5; i++) ram[base + i] = bytes[i]; }

/** Side 1, one player, the first opponent, nothing scored. */
function practice() {
  ram[SIDE1] = 214;
  ram[SIDE2] = 0x1c;
  ram[BA] = 0;
  ram[B9] = 128;
  ram[BD] = 0;
  ram[BE] = 0;
  ram[BB] = 0;
  ram[AF] = 0;
  ram[E1] = 12;
  ram[E2] = 12;
  ram[POSE] = 0x80;
  ram[HEAD] = 0;
  digits(P1, 0);
  quiet(P2, [0x00, 0x02, 0x00, 0x24, 0x02]);
}
/** Side 2, the duel, the first opponent, nothing scored. */
function duel() {
  ram[SIDE2] = 214;
  ram[SIDE1] = 0x1c;
  ram[BA] = 0;
  ram[B9] = 128;
  ram[BD] = 0;
  ram[BE] = 0;
  ram[BB] = 0;
  ram[AF] = 0;
  ram[E1] = 12;
  ram[E2] = 12;
  ram[POSE] = 0x80;
  ram[HEAD] = 0;
  digits(P2, 0);
  quiet(P1, [0x15, 0x05, 0x05, 0x05, 0x05]);
}

// 1. Every condition parses, and the set names all six files and both scores.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  for (const h of Object.values(HASHES)) expect(set.hashes.some((x) => x.hash === h), `the set names ${h}`);
  expect(set.hashes.length === 6, 'both sides in cartridge, crunched and uncrunched form');
  expect(set.title === 'Barbarian: The Ultimate Warrior', 'the set uses the full title');
  expect(set.url === 'https://www.lemon64.com/game/barbarian-the-ultimate-warrior', 'the set links the game on Lemon64');
  expect(set.achievements.length === 10, 'ten achievements');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 180, 'the achievements add up to 180 points');
  expect(set.leaderboards?.length === 2, 'two boards');
  for (const l of set.leaderboards) {
    expect(l.format === 'SCORE' && l.lowerIsBetter === false, `${l.title} is a score, higher is better`);
    expect(/STA:.*::CAN:.*::SUB:.*::VAL:/.test(l.definition), `${l.title} has start, cancel, submit and value`);
  }
  ok(`all ${set.achievements.length} achievements and both scores parse`);
}

// 2. Each listed hash is that file's rcheevos hash.
for (const [key, hash] of Object.entries(HASHES)) {
  let file = null;
  try { file = assetPath(key); } catch { /* not registered yet */ }
  if (!file) {
    let note = `${key} is not registered in test/external-assets.json`;
    try { note = missingNote(key); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: ${key} hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === hash, `${path.basename(file)} hashes to ${hash}`);
    ok(`${key} hashes to the listed hash`);
  }
}

// 3. The demo unlocks nothing and posts nothing.
{
  fresh();
  ram[SIDE1] = 214;
  ram[SIDE2] = 214;
  ram[BA] = 0;
  ram[B9] = 0;
  ram[BD] = 0;
  ram[BE] = 4;
  ram[E1] = 12;
  ram[E2] = 12;
  ram[POSE] = 0x80;
  digits(P1, 0);
  digits(P2, 0);
  frames(2);
  digits(P1, 99999);
  digits(P2, 99999);
  ram[E2] = 0;
  ram[POSE] = 136;
  ram[HEAD] = 128;
  ram[AF] = 129;
  ram[BB] = 128;
  ram[BE] = 7;
  frames(3);
  expectNames('demo', []);
  expect(of(PRACTICE, EVENT.LBOARD_STARTED).length === 0 && of(DUEL, EVENT.LBOARD_STARTED).length === 0, 'the demo does not start a board');
  expect(submits(PRACTICE).length === 0 && submits(DUEL).length === 0, 'the demo posts nothing');
  expect(cancels(PRACTICE).length === 0 && cancels(DUEL).length === 0, 'the demo cancels nothing');
  ok('the demo unlocks nothing and posts nothing');
}

// 4. A condition that is already true on the first frame does not fire.
{
  activate();
  ram[SIDE2] = 214;
  ram[BA] = 0;
  ram[B9] = 128;
  ram[BD] = 0;
  ram[BE] = 7;
  ram[BB] = 128;
  ram[E1] = 11;
  ram[E2] = 12;
  ram[POSE] = 136;
  ram[HEAD] = 128;
  ram[AF] = 129;
  digits(P1, 5000);
  digits(P2, 5000);
  frame();
  expectNames('true before it has been false', []);
  expect(of(PRACTICE, EVENT.LBOARD_STARTED).length === 0 && of(DUEL, EVENT.LBOARD_STARTED).length === 0, 'neither board starts on a first frame');
  frame();
  expectNames('still true on the next frame', []);
  digits(P1, 0);
  digits(P2, 0);
  ram[BB] = 0;
  ram[POSE] = 0x80;
  ram[HEAD] = 0;
  ram[BE] = 6;
  frame();
  expectNames('after it has been false', []);
  digits(P2, 5000);
  ram[BB] = 128;
  ram[POSE] = 136;
  ram[HEAD] = 128;
  ram[AF] = 129;
  ram[BE] = 7;
  frame();
  expectNames('true again', ['Down with Drax', 'Heads Will Roll', 'Sword for Hire', 'Warming Up', 'The Ultimate Warrior', 'Last Man Standing']);
  expect(submits(DUEL).length === 0 && of(DUEL, EVENT.LBOARD_STARTED).length === 0, 'the duel stays quiet while energy is down and the score was never zero');
  ok('a first frame that is already true does not unlock or start a board');
}

// 5. The practice board waits until a start has been false, then begins.
{
  activate();
  practice();
  frame();
  frame();
  expect(of(PRACTICE, EVENT.LBOARD_STARTED).length === 0, 'a start that is already true does not begin the board');
  ram[B9] = 0;
  frame();
  ram[B9] = 128;
  frame();
  expect(of(PRACTICE, EVENT.LBOARD_STARTED).length === 1, 'the board begins once the start has been false');
  expect(of(DUEL, EVENT.LBOARD_STARTED).length === 0, 'side 1 does not start the duel');
  ok('practice starts on a fresh one-player fight');
}

// The player-selection screen is not the fight. F7 changes $B9 to 128 while
// $BA returns to 0, and only then can the board and score achievements start.
{
  fresh();
  practice();
  ram[BA] = 128;
  ram[B9] = 0;
  frames(2);
  expect(of(PRACTICE, EVENT.LBOARD_STARTED).length === 0, '1PLR selection does not start Practice');
  digits(P1, 500); frames(1);
  expectNames('selection screen score', []);
  digits(P1, 0);
  ram[BA] = 0;
  ram[B9] = 128;
  frame();
  expect(of(PRACTICE, EVENT.LBOARD_STARTED).length === 1, 'F7 fight state starts Practice');
  digits(P1, 500); frame();
  expectNames('fight score', ['Warming Up']);
  ok('selection stays quiet and the F7 fight state counts');
}

// 6. Blows, the head, and the score steps. Two player scores, and does not climb.
{
  fresh();
  practice();
  frames(1);
  for (const n of [50, 100, 200, 400, 499]) {
    digits(P1, n);
    frames(1);
  }
  expectNames('under 500', []);
  digits(P1, 500); frames(1);
  digits(P1, 999); frames(1);
  digits(P1, 1000); frames(1);
  digits(P1, 1999); frames(1);
  expectNames('500 and 1000', ['Warming Up']);
  digits(P1, 2000); frames(1);
  digits(P1, 4999); frames(1);
  expectNames('2000', ['Warming Up', 'Sword for Hire']);
  digits(P1, 5000); frames(1);
  expectNames('5000', ['Warming Up', 'Sword for Hire', 'The Ultimate Warrior']);
  expect(submits(PRACTICE).length === 0, 'scoring does not post');

  fresh();
  practice();
  ram[BD] = 1;
  frames(1);
  expect(of(PRACTICE, EVENT.LBOARD_STARTED).length === 0, 'two player does not start practice');
  ram[E2] = 11; frames(1);
  ram[POSE] = 136; ram[HEAD] = 128; ram[AF] = 129; frames(1);
  digits(P1, 500); frames(1);
  ram[BE] = 1; frames(1);
  ram[BE] = 4; frames(1);
  ram[BE] = 7; frames(1);
  ram[E1] = 0; ram[AF] = 128; frames(2);
  expectNames('two player', ['First Blood', 'Heads Will Roll', 'Warming Up']);
  expect(submits(PRACTICE).length === 0 && submits(DUEL).length === 0, 'two player posts nothing');
  ok('blows and scores count, and two player does not climb or post');
}

// A visible head pose alone is not the decapitation. The head animation's
// $025C marker must appear with the opponent as the fallen fighter.
{
  fresh();
  practice();
  frames(2);
  ram[POSE] = 136; frames(2);
  expect(!names().includes('Heads Will Roll'), 'a head-height pose without a severed head does not count');
  ram[HEAD] = 128; ram[AF] = 128; frames(2);
  expect(!names().includes('Heads Will Roll'), 'losing your own head does not count');
  ram[HEAD] = 0; ram[AF] = 0; frames(2);
  ram[HEAD] = 128; ram[AF] = 129; frames(2);
  expect(names().includes('Heads Will Roll'), 'the opponent head animation counts on side 1');

  fresh();
  duel();
  frames(2);
  ram[HEAD] = 128; ram[AF] = 129; frames(2);
  expect(names().includes('Heads Will Roll'), 'the opponent head animation counts on side 2');
  ok('decapitation uses the head animation on both sides');
}

// 7. One player climbs. An untouched win counts. Side 1 never defeats Drax.
{
  fresh();
  practice();
  frames(1);
  ram[BE] = 1; frames(1);
  expectNames('first win, still on 12', ['Victor', 'Untouchable']);
  ram[E1] = 11; frames(1);
  ram[BE] = 2; frames(1);
  ram[BE] = 3; frames(1);
  ram[BE] = 4; frames(1);
  expectNames('four wins, after a hit', ['Victor', 'Four in a Row', 'Untouchable']);
  ram[BE] = 5; frames(1);
  ram[BE] = 6; frames(1);
  ram[BE] = 7; frames(1);
  ram[BB] = 128; frames(2);
  expectNames('the last opponent', ['Victor', 'Four in a Row', 'Last Man Standing', 'Untouchable']);
  expect(submits(PRACTICE).length === 0, 'winning a fight posts nothing');
  ok('the one-player ladder counts, and side 1 has no Drax');
}

// 8. Practice posts a scored fall once, and cancels a fall on zero.
{
  fresh();
  practice();
  frames(1);
  expect(of(PRACTICE, EVENT.LBOARD_STARTED).length === 1, 'the fresh fight starts practice');
  ram[BE] = 1; frames(1);
  digits(P1, 500); frames(1);
  expect(submits(PRACTICE).length === 0, 'the win and the points are not the end');
  ram[E1] = 0;
  ram[AF] = 128;
  frames(1);
  frames(3);
  const posted = submits(PRACTICE);
  expect(posted.length === 1 && posted[0].value === 500, `the fall posts 500 once (got ${posted.map((e) => e.value)})`);
  expect(submits(DUEL).length === 0 && cancels(PRACTICE).length === 0, 'a scored fall is not canceled and is not the duel');

  fresh();
  practice();
  frames(1);
  ram[E1] = 0;
  ram[AF] = 128;
  frames(2);
  expect(submits(PRACTICE).length === 0, 'a fall on zero posts nothing');
  expect(cancels(PRACTICE).length === 1, 'a fall on zero is canceled');
  expect(cancels(DUEL).length === 0, 'side 1 does not cancel the duel');
  ok('practice posts a scored fall once and cancels a fall on zero');
}

// 9. Side 2's own digits, then the duel posts Drax or a fall, and cancels a zero.
{
  fresh();
  duel();
  frames(1);
  expect(of(DUEL, EVENT.LBOARD_STARTED).length === 1 && of(PRACTICE, EVENT.LBOARD_STARTED).length === 0, 'the duel starts, practice does not');
  digits(P2, 499); frames(1);
  expectNames('side 2 under 500', []);
  digits(P2, 2500); frames(1);
  expectNames('side 2 score', ['Sword for Hire', 'Warming Up']);
  for (let n = 1; n <= 7; n++) { ram[BE] = n; frames(1); }
  expect(submits(DUEL).length === 0, 'reaching the last opponent posts nothing');
  expectNames('facing the last', ['Victor', 'Four in a Row', 'Sword for Hire', 'Warming Up', 'Last Man Standing', 'Untouchable']);
  ram[BB] = 128; frames(1);
  frames(3);
  const posted = submits(DUEL);
  expect(posted.length === 1 && posted[0].value === 2500, `Drax posts 2500 once (got ${posted.map((e) => e.value)})`);
  expect(names().includes('Down with Drax'), 'defeating Drax counts');
  expect(submits(PRACTICE).length === 0, 'side 2 does not post practice');

  fresh();
  duel();
  frames(1);
  digits(P2, 1500); frames(1);
  ram[E1] = 0;
  ram[AF] = 128;
  frames(2);
  const fell = submits(DUEL);
  expect(fell.length === 1 && fell[0].value === 1500, `a fall in the duel posts 1500 (got ${fell.map((e) => e.value)})`);
  expect(!names().includes('Down with Drax'), 'a fall is not Drax');

  fresh();
  duel();
  frames(1);
  ram[BB] = 128;
  frames(2);
  expect(names().includes('Down with Drax'), 'Drax counts with nothing scored');
  expect(submits(DUEL).length === 0, 'a duel that ends on zero posts nothing');
  expect(cancels(DUEL).length === 1, 'a duel that ends on zero is canceled');
  ok('the duel posts a scored end once and cancels an end on zero');
}

// 10. Only the running side's score qualifies, even if the other side's RAM
// happens to contain digit-shaped bytes.
{
  fresh();
  duel();
  frames(1);
  expectNames('side 2 quiet bytes', []);
  digits(P1, 10000); frames(1);
  expectNames('side 1 digits during the duel', []);
  fresh();
  practice();
  frames(1);
  expectNames('side 1 quiet bytes', []);
  digits(P2, 10000); frames(1);
  expectNames('side 2 digits during practice', []);
  digits(P1, 4250); frames(1);
  expectNames('4250 during practice', ['Warming Up', 'Sword for Hire']);
  digits(P1, 5000); frames(1);
  expectNames('5000 during practice', ['Warming Up', 'Sword for Hire', 'The Ultimate Warrior']);
  ok('only the active side scores, at the actual thresholds');
}

// A 2PLR selection and a return to the demo end an in-progress attempt.
{
  fresh();
  practice();
  frames(1);
  expect(of(PRACTICE, EVENT.LBOARD_STARTED).length === 1, 'practice starts in 1PLR');
  ram[BD] = 1;
  frames(1);
  expect(cancels(PRACTICE).length === 1, 'switching to 2PLR cancels practice');
  digits(P1, 4250);
  frames(2);
  ram[AF] = 128;
  frames(1);
  expect(submits(PRACTICE).length === 0, 'a canceled 2PLR attempt does not post');

  fresh();
  practice();
  frames(1);
  ram[B9] = 0;
  frames(1);
  expect(cancels(PRACTICE).length === 1, 'returning to demo cancels practice');
  digits(P1, 4250);
  frames(2);
  expect(submits(PRACTICE).length === 0, 'demo points do not post');

  fresh();
  duel();
  frames(1);
  ram[BD] = 1;
  frames(1);
  expect(cancels(DUEL).length === 1, 'switching to 2PLR cancels the duel');
  ok('two-player and demo transitions cancel both boards');
}

// Untouchable is a challenge: live in a fight while your energy is full, out at the first blow taken.
{
  const t = set.achievements.find((a) => a.title === 'Untouchable').id;
  fresh();
  expect(!primed.has(t), 'not live before a fight');
  practice(); frames(2);
  expect(primed.has(t), 'live as a fight starts');
  ram[E1] = 11; frames(2);
  expect(!primed.has(t) && !unlocked.has(t), 'out at the first blow taken');
  ram[E1] = 12; frames(2);
  expect(primed.has(t), 'live again when the next fight refills the energy');
  ram[BE] = 1; frames(1);
  expect(unlocked.has(t), 'and earned by winning it');
  ok('Untouchable: live, out, and live again');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - barbarian set: ${testNo} checks`);
