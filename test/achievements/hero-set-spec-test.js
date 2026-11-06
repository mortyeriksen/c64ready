// Spec tests for the H.E.R.O. achievement set (server/sets/hero.json, Activision 1984 on the OneLoad64
// cartridge) under rcheevos, on synthesized RAM laid out as the game keeps it:
//   $0051 $FF while a game is played; 0 in the demo, which plays several levels on its own.
//   $0058 the level, counted from 0. $0053-$0055 the score in BCD, high byte first.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/hero.json'), 'utf8')), 'hero.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '036909ac2dbedc273a2b2cb0474e3dda';

const unlocked = new Set();
function activate() {
  rc.clear(); unlocked.clear(); ram.fill(0);
  return set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
}
function frame() { for (const e of rc.doFrame(ram)) if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id); }
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', '), exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const score = (n) => { const s = String(n).padStart(6, '0'); for (let i = 0; i < 3; i++) ram[0x53 + i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); frames(2); };
const level = (n) => { ram[0x58] = n - 1; frames(2); };
/** A new game on level 1. */
function begin() { activate(); frames(2); ram[0x51] = 0xff; frames(2); }

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('hero-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'hero-crt is not registered in test/external-assets.json';
    try { note = missingNote('hero-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. The demo rescues miners and scores; none of it counts.
{
  activate(); frames(2);
  for (let n = 2; n <= 5; n++) { level(n); score(n * 30000); }
  expectNames('the demo', []);
  ok('the demo counts for nothing');
}

// 4. Rescues, level by level, and the score.
{
  begin();
  for (let n = 2; n <= 20; n++) { level(n); score(n * 6000); }
  expectNames('the whole game', ['A Hundred Thousand', 'Fifty Thousand', 'First Rescue', 'Level 10', 'Level 15', 'Level 20', 'Level 5', 'Ten Thousand']);
  ok('rescues and score');
}

// 5. A game begun on a later level does not count the levels it skipped.
{
  begin();
  level(9); level(10);
  expectNames('from level 9', ['Level 10']);
  ok('only levels reached from the one before count');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - H.E.R.O. set: ${testNo} spec checks`);
