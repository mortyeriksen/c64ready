// The range a leaderboard's value can take (server/value-bounds.mjs), worked out from its VAL
// expression: each memory read holds its size's range (a byte 0 to 255, a nibble 0 to 15, BCD
// every digit up to 15), multiplied, added and subtracted as written, the greatest alternative
// counting. A measured hit count has no top, and a sum that can pass 32 bits (which rcheevos
// wraps round) no bound at all. Checked on expressions written here, and on every
// board of server/sets/ against rcheevos itself (src/achievements/rcheevos.js), evaluating each
// value over memory filled with every byte at its extremes and at random: what rcheevos produces
// is never outside the range.

import fs from 'node:fs';
import { valueBounds } from '../../server/value-bounds.mjs';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`); for (const m of current) console.log(`     - ${m}`); current = []; }
}
const b = (val) => valueBounds(`STA:1=1::CAN:0=1::SUB:0=1::VAL:${val}`);
const is = (val, min, max) => { const r = b(val); expect(r.min === min && r.max === max, `${val}: expected [${min}, ${max}], got [${r.min}, ${r.max}]`); };

is('0xH1234', 0, 255);
is('0xL1234*10_0xU1234', 0, 165);
is('0x1234', 0, 65535);
is('b0xH1234*100_b0xH1235', 0, 16665);
is('d0xH1234*2', 0, 510);
is('0xK1234', 0, 8);
is('0xM1234', 0, 1);
ok('a memory read holds its size\'s range, BCD every digit up to 15');

is('A:0xH10*60_B:0xH11_M:59', -196, 15359);
is('C:1=1_M:1=1', 0, null);
is('Q:0xH10=1_M:0xH11', 0, 255);
is('A:0xH10_B:v48_M:v0', -48, 207);
is('0xH10*10$0xH11', 0, 2550);
is('0xH10/4', 0, 63);
ok('sums, differences, hit counts, conditions and alternatives');

is('fM0x35ED', null, null);
is('I:0xH10_M:0xH20', null, null);
is('0xH10*10000000_0xH11*10000000', null, null);
expect(valueBounds('no value here').min === null && valueBounds(undefined).max === null, 'no VAL, no bound');
ok('what it does not understand, or what passes 32 bits, sets no bound');

// Every board in the sets, against rcheevos.
const rc = await loadRcheevos();
const boards = [];
for (const f of fs.readdirSync(new URL('../../server/sets/', import.meta.url)).filter((f) => f.endsWith('.json')).sort()) {
  const set = JSON.parse(fs.readFileSync(new URL(`../../server/sets/${f}`, import.meta.url), 'utf8'));
  for (const l of set.leaderboards ?? []) boards.push({ name: `${set.id} ${l.id}`, val: l.definition.split('::VAL:')[1] });
}
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0xff;
const fills = [() => 0, () => 0xff, () => 0x99, () => 0x0f, () => 0xf0, rand, rand, rand, rand, rand];
let bounded = 0, checked = 0;
for (const { name, val } of boards) {
  const { min, max } = b(val);
  if (min != null || max != null) bounded++;
  // A board that starts when $FFFF turns to 1 and never ends: its value comes every frame from then
  // on, from the memory as filled. Its first frame has $FFFF at 0, so the start is seen as one.
  rc.clear();
  expect(rc.activateLeaderboard(1, `STA:0xHffff=1::CAN:0=1::SUB:0=1::VAL:${val}`) === 0, `${name}: rcheevos parses the board`);
  const ram = new Uint8Array(0x10000);
  rc.doFrame(ram);
  for (let i = 0; i < 40; i++) {
    const fill = fills[i % fills.length];
    for (let a = 0; a < ram.length; a++) ram[a] = fill();
    ram[0xffff] = 1;
    for (const e of rc.doFrame(ram)) {
      if (e.type !== EVENT.LBOARD_STARTED && e.type !== EVENT.LBOARD_UPDATED) continue;
      checked++;
      const v = e.value | 0;
      expect((min == null || v >= min) && (max == null || v <= max), `${name}: rcheevos gave ${v}, outside [${min}, ${max}]`);
    }
  }
}
expect(checked > boards.length * 10, `rcheevos gave values to check (${checked})`);
expect(bounded >= boards.length - 5, `every board but a few has a bound (${bounded} of ${boards.length})`);
ok(`rcheevos never gives a value outside its board's range (${boards.length} boards, ${checked} values)`);

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nok - leaderboard value bounds: ${testNo} checks`);
