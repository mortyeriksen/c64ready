// Shared spec checks for the International Karate sets (the 1986 original and the 2018 Ultimate
// edition), which read the same variables, under rcheevos on synthesized RAM:
//   $0045 1 while a game is played (0 in the demo), $0046 0 for one player, 1 for two.
//   $006B the level, 1 at the start and one more for each bout or bonus round won.
//   $0074-$0076 player 1's score in BCD, high byte first.
//   $AD40 the belt: 0 white, 1 yellow, 2 green, 3 blue, 4 purple, 5 brown, 6 black.
//   The belt names ("WHITE...") sit at a fixed place in each game: `sig` below.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { checkSet } from '../../server/games.mjs';
import { assetPath, missingNote } from '../external-assets.js';

export async function karateSpec({ id, sig, assets, trainer = null }) {
  let testNo = 0, failing = 0, current = [];
  const expect = (cond, msg) => { if (!cond) current.push(msg); };
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
  const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, `server/sets/${id}.json`), 'utf8')), `${id}.json`);
  const rc = await loadRcheevos();
  const ram = new Uint8Array(0x10000);
  const NOTICE = 0x7ffffff0, OVER = 0x7fffffff;

  const unlocked = new Set();
  const boards = [];
  let over = 0, noticed = 0;
  function activate() {
    rc.clear(); unlocked.clear(); boards.length = 0; over = 0; noticed = 0; ram.fill(0);
    const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
    codes.push(rc.activateLeaderboard(1, set.leaderboards[0].definition));
    codes.push(rc.activateAchievement(OVER, set.gameOver));
    for (const n of set.notices ?? []) codes.push(rc.activateAchievement(NOTICE, n.memaddr));
    return codes;
  }
  function frame() {
    for (const e of rc.doFrame(ram)) {
      if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) { if (e.id === OVER) over++; else if (e.id === NOTICE) noticed++; else unlocked.add(e.id); }
      else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
    }
  }
  const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
  const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
  const expectNames = (label, want) => {
    const got = names().join(', '), exp = [...want].sort().join(', ');
    expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
  };
  const score = (n) => { const s = String(n).padStart(6, '0'); for (let i = 0; i < 3; i++) ram[0x74 + i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); };
  /** The demo running, then a game for `players`. */
  function begin(players = 1) {
    activate();
    ram.set([...Buffer.from('WHITE')], sig);
    ram[0x6b] = 1; score(800); frames(2);
    ram[0x45] = 1; ram[0x46] = players - 1; score(0); frames(2);
  }

  // 1. Every condition parses.
  {
    const codes = activate();
    codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
    ok(`all ${set.achievements.length} achievements, the board and the game over parse`);
  }

  // 2. Each listed hash is its file's rcheevos hash.
  for (const [key, hash] of assets) {
    let file = null;
    try { file = assetPath(key); } catch { /* not registered */ }
    if (!file) {
      let note = `${key} is not registered in test/external-assets.json`;
      try { note = missingNote(key); } catch { /* keep the note */ }
      console.log(`ok  - test ${++testNo}: ${key} hashes to the listed hash # SKIP ${note}`);
    } else {
      expect(set.hashes.some((h) => h.hash === hash), `the set lists ${hash}`);
      expect(rc.hash(fs.readFileSync(file)) === hash, `${path.basename(file)} hashes to ${hash}`);
      ok(`${key} hashes to the listed hash`);
    }
  }

  // 3. The demo fights bouts and scores, and two players can; neither counts.
  {
    activate();
    ram.set([...Buffer.from('WHITE')], sig);
    ram[0x6b] = 1; frames(2);
    ram[0x6b] = 2; score(12000); ram[0xad40] = 2; frames(2);
    begin(2);
    ram[0x6b] = 2; score(12000); ram[0xad40] = 2; frames(2);
    expectNames('the demo and two players', []);
    expect(boards.length === 0, 'neither starts the board');
    ok('the demo and two-player games count for nothing');
  }

  // 4. A one-player game: the first bout, every belt, score milestones.
  {
    begin();
    ram[0x6b] = 2; score(1600); frames(2);
    expectNames('a bout won', ['First Bout']);
    for (let b = 1; b <= 6; b++) { ram[0xad40] = b; frames(2); }
    score(9999); frames(2); score(10000); frames(2); score(30000); frames(2); score(60000); frames(2); score(100000); frames(2);
    expectNames('all of it', ['A Hundred Thousand', 'Black Belt', 'Blue Belt', 'Brown Belt', 'First Bout', 'Green Belt', 'Purple Belt',
      'Sixty Thousand', 'Ten Thousand', 'Thirty Thousand', 'Yellow Belt']);
    ok('bouts, belts and points');
  }

  // 5. The board: the score when the game ends, if any.
  {
    begin();
    expect(boards.filter((e) => e.type === EVENT.LBOARD_STARTED).length === 1, 'a game starts the board');
    score(23400); frames(2);
    ram[0x45] = 0; frames(1); score(0); frames(2);
    const sub = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
    expect(sub.length === 1 && sub[0].value === 23400, `23,400 is posted (got ${sub.map((e) => e.value).join(',') || 'nothing'})`);
    expect(over === 1, 'the game is over');
    begin();
    ram[0x45] = 0; frames(2);
    expect(boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED).length === 0, 'a game without points posts nothing');
    ok('the board');
  }

  // 6. The trainer notice.
  if (trainer) {
    begin();
    expect(noticed === 0, 'no notice without the trainer');
    ram[trainer] = 0xea; frames(2);
    expect(noticed === 1, 'the trainer is noticed');
    ok('the trainer notice');
  }

  // 7. Each score tier's score is what the board posts for a game ending right at the tier: a
  //     post at or above it stays off the public wall until the tier is unlocked.
  {
    const tiers = set.achievements.filter((a) => a.score !== undefined);
    expect(tiers.map((a) => a.title).join() === ['Ten Thousand', 'Thirty Thousand', 'Sixty Thousand', 'A Hundred Thousand'].join(), `the score tiers (got ${tiers.map((a) => a.title).join()})`);
    for (const a of tiers) {
      begin(); score(a.score); frames(2); ram[0x45] = 0; frames(1); score(0); frames(2);
      expect(unlocked.has(a.id), `${a.title} unlocks at ${a.score}`);
      const sub = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED).map((e) => e.value);
      expect(sub.at(-1) === a.score, `${a.title}: a game ending at the tier posts ${a.score} (got ${sub.join(',') || 'nothing'})`);
    }
    ok('score tiers match the board');
  }

  if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
  console.log(`\nok - ${set.title} set: ${testNo} spec checks`);
}
