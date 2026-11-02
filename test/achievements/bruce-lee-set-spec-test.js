// Spec tests for the Bruce Lee achievement set (server/sets/bruce-lee.json,
// Datasoft 1984, on the OneLoad64 v5 cartridge).
// Play is the score routine at $3172 (the PHA opcode, 72) together with the
// FALLS label at $8C45. The title is still packed, so that byte is 255, and
// the options menu has the routine but the label is still 220.
// $28 is falls in reserve, 4 at the start. Reaching 0 is still play. The next
// fall wraps it to 255 and the run is over. $29 is the room, 0 in the first
// chamber. $2A is how many lanterns that chamber has left, 6 until one is
// taken. $4389 to $438B are the BCD score the HUD prints. $97 is the ninja,
// 65 while he is up and 64 once he is knocked out.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/bruce-lee.json'), 'utf8')), 'bruce-lee.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'ac19ecbfe808b0291a328f65e56ffbe6';
const PHA = 0x3172, FALLS = 0x28, ROOM = 0x29, LAN = 0x2a, NINJA = 0x97;
const BCD = [0x4389, 0x438a, 0x438b];
const ALLS = [0x8c45, 0x8c46, 0x8c47, 0x8c48];
const LABEL = [33, 44, 44, 51];

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
const fresh = () => { activate(); frames(2); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const submits = () => boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
const starts = () => boards.filter((e) => e.type === EVENT.LBOARD_STARTED);

function setBcd(n) {
  const s = String(n).padStart(6, '0');
  ram[BCD[0]] = Number(s[0]) * 16 + Number(s[1]);
  ram[BCD[1]] = Number(s[2]) * 16 + Number(s[3]);
  ram[BCD[2]] = Number(s[4]) * 16 + Number(s[5]);
}
function latch() {
  ram[PHA] = 72;
  for (let i = 0; i < 4; i++) ram[ALLS[i]] = LABEL[i];
}
/** The HUD is up, four falls, the first chamber, nothing scored. */
function play() {
  fresh();
  latch();
  ram[FALLS] = 4;
  ram[ROOM] = 0;
  ram[LAN] = 6;
  ram[NINJA] = 0;
  setBcd(0);
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge and its one score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.url === 'https://www.lemon64.com/game/bruce-lee', 'the set links the game on Lemon64');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE' && set.leaderboards[0].lowerIsBetter === false, 'one score board, higher is better');
  expect(set.achievements.length === 10, 'ten achievements');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 130, 'the achievements add up to 130 points');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('bruce-lee-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'bruce-lee-crt is not registered in test/external-assets.json';
    try { note = missingNote('bruce-lee-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The title and the options menu unlock nothing and do not start a score.
{
  fresh();
  ram[PHA] = 255;
  ram[FALLS] = 0;
  ram[ROOM] = 10;
  ram[LAN] = 5;
  ram[NINJA] = 64;
  ram[BCD[0]] = 0x00;
  ram[BCD[1]] = 0xff;
  ram[BCD[2]] = 0xff;
  ram[ALLS[0]] = 255;
  frames(2);
  ram[LAN] = 6; frames(1);
  ram[LAN] = 5; frames(2);
  ram[NINJA] = 65; frames(1);
  ram[NINJA] = 64; frames(2);
  expectNames('title', []);
  expect(starts().length === 0 && submits().length === 0, 'the title does not start or post a score');

  fresh();
  ram[PHA] = 72;
  for (const a of ALLS) ram[a] = 220;
  ram[FALLS] = 4;
  ram[ROOM] = 0;
  ram[LAN] = 6;
  setBcd(0);
  frames(2);
  expect(starts().length === 0, 'the menu does not start the board');
  ram[ROOM] = 10;
  setBcd(40000);
  ram[LAN] = 5; frames(2);
  ram[LAN] = 0; frames(2);
  ram[NINJA] = 65; frames(1);
  ram[NINJA] = 64; frames(2);
  expectNames('menu', []);
  expect(starts().length === 0 && submits().length === 0, 'the menu posts nothing');
  ok('the title and the menu unlock nothing and post nothing');
}

// 4. The first chamber, score still zero, starts the board and unlocks nothing.
{
  play();
  expectNames('first chamber', []);
  expect(starts().length === 1 && submits().length === 0, 'the board starts once');
  ok('a fresh game starts the board and unlocks nothing');
}

// 5. Lanterns count down only in the first chamber.
{
  play();
  ram[ROOM] = 1;
  ram[FALLS] = 3;
  ram[LAN] = 5; frames(2);
  expectNames('lantern in the next chamber', ['Onward']);

  play();
  ram[LAN] = 5; frames(2);
  expectNames('one lantern', ['Light Fingers']);
  ram[LAN] = 4; frames(2);
  expectNames('two lanterns', ['Light Fingers']);
  ram[LAN] = 1; frames(2);
  expectNames('one left', ['Light Fingers']);
  ram[ROOM] = 10;
  ram[FALLS] = 3;
  ram[LAN] = 0; frames(2);
  expectNames('last lantern in a later chamber', ['Light Fingers', 'Onward', 'Deeper In']);

  play();
  ram[LAN] = 5; frames(2);
  ram[LAN] = 1; frames(2);
  ram[LAN] = 0; frames(2);
  expectNames('every lantern', ['Light Fingers', 'Lights Out']);
  ok('lanterns count in the first chamber only');
}

// 6. Score rungs follow the BCD digits. A jump to 40000 counts for each rung.
{
  play();
  setBcd(125); frames(2);
  expectNames('125', ['Enter the Dragon']);
  setBcd(999); frames(2);
  expectNames('999', ['Enter the Dragon']);
  setBcd(1000); frames(2);
  expectNames('1000', ['Enter the Dragon', 'A Thousand Kicks']);
  setBcd(9999); frames(2);
  expectNames('9999', ['Enter the Dragon', 'A Thousand Kicks']);
  setBcd(10000); frames(2);
  expectNames('10000', ['Enter the Dragon', 'A Thousand Kicks', 'Ten Thousand']);
  setBcd(39999); frames(2);
  expectNames('39999', ['Enter the Dragon', 'A Thousand Kicks', 'Ten Thousand']);
  setBcd(40000); frames(2);
  expectNames('40000', ['Enter the Dragon', 'A Thousand Kicks', 'Ten Thousand', 'Forty Thousand']);

  play();
  setBcd(40000); frames(2);
  expectNames('jump', ['Enter the Dragon', 'A Thousand Kicks', 'Ten Thousand', 'Forty Thousand']);
  ok('the score rungs follow the digits on screen');
}

// 7. Leaving the first chamber, a later chamber, and a clean exit.
{
  play();
  ram[FALLS] = 3;
  ram[ROOM] = 1; frames(2);
  expectNames('one fall already lost', ['Onward']);
  ram[ROOM] = 9; frames(2);
  expectNames('room 9', ['Onward']);

  play();
  ram[ROOM] = 1; frames(2);
  expectNames('clean first step', ['Onward', 'Like Water']);
  ram[ROOM] = 9; frames(2);
  expectNames('still short of the later chamber', ['Onward', 'Like Water']);
  ram[ROOM] = 10; frames(2);
  expectNames('later chamber', ['Onward', 'Like Water', 'Deeper In']);

  play();
  ram[ROOM] = 10; frames(2);
  expectNames('straight to the later chamber', ['Onward', 'Like Water', 'Deeper In']);
  ok('later chambers stay locked on the first screen');
}

// 8. The ninja's alive bit has to fall from 65 to 64 during play.
{
  play();
  ram[NINJA] = 64; frames(2);
  expectNames('already down', []);
  ram[NINJA] = 65; frames(2);
  expectNames('up', []);
  ram[NINJA] = 64; frames(2);
  expectNames('knocked out', ['Ninja Down']);
  ok('knocking out the ninja unlocks once');
}

// 9. Clearing the first chamber, even to 40000, does not open a later room.
{
  play();
  ram[LAN] = 5; frames(2);
  ram[LAN] = 1; frames(2);
  ram[LAN] = 0; frames(2);
  setBcd(40000); frames(2);
  expectNames('first chamber cleared', ['Light Fingers', 'Lights Out', 'Enter the Dragon', 'A Thousand Kicks', 'Ten Thousand', 'Forty Thousand']);
  ok('the first chamber cannot finish the set');
}

// 10. Game over posts the BCD score once. Zero posts nothing, and one lost fall posts nothing.
{
  function finish(n) {
    play();
    setBcd(n);
    frames(2);
    ram[FALLS] = 0; frames(2);
    ram[FALLS] = 255; frames(2);
    frames(4);
    return submits();
  }
  let s = finish(0);
  expect(s.length === 0, 'a score of zero posts nothing');
  s = finish(125);
  expect(s.length === 1 && s[0].value === 125, `game over submits 125 (got ${s.map((e) => e.value)})`);
  s = finish(4125);
  expect(s.length === 1 && s[0].value === 4125, `game over submits 4125 (got ${s.map((e) => e.value)})`);
  s = finish(40000);
  expect(s.length === 1 && s[0].value === 40000, `game over submits 40000 (got ${s.map((e) => e.value)})`);

  play();
  setBcd(750);
  ram[FALLS] = 4; frames(2);
  ram[FALLS] = 3; frames(2);
  expect(submits().length === 0, 'losing one fall posts nothing');
  ram[FALLS] = 1; frames(2);
  ram[FALLS] = 0; frames(2);
  expect(submits().length === 0, 'the last fall still in hand posts nothing');
  ok('the score posts when the last fall is lost');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - bruce lee set: ${testNo} spec checks`);
