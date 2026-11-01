// Spec tests for rcheevos as the app runs it (src/achievements/rcheevos.js, the
// embedded WebAssembly build of native/rcheevos). Expectations come from
// RetroAchievements' documentation of its condition syntax and runtime
// (docs.retroachievements.org: achievement logic, leaderboards, hashing), on
// synthesized RAM, one frame at a time.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { assetPath } from '../external-assets.js';

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

const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const frame = () => rc.doFrame(ram).map((e) => ({ ...e }));
const has = (events, type, id) => events.some((e) => e.type === type && e.id === id);
const triggered = (events, id) => has(events, EVENT.ACHIEVEMENT_TRIGGERED, id);

// 1. Hashing: a C64 file is named by the MD5 of the whole file.
{
  const file = crypto.randomBytes(5000);
  expect(rc.hash(file) === crypto.createHash('md5').update(file).digest('hex'), 'the C64 hash is the MD5 of the whole file');
  const uridium = assetPath('uridium-crt');
  if (uridium) expect(rc.hash(fs.readFileSync(uridium)) === '4255c6e2bd6ebe048dfef457a920d565', 'the OneLoad64 Uridium cartridge hashes to the value its set lists');
  expect(/^\d+\.\d+\.\d+$/.test(rc.versionString), `the module reports its rcheevos version (${rc.versionString})`);
  ok(`hashing (rcheevos ${rc.versionString})${uridium ? '' : ' # SKIP the Uridium check: asset uridium-crt not found'}`);
}

// 2. An achievement true when it is first evaluated waits until it has been false.
{
  rc.clear(); ram.fill(0);
  ram[0x10] = 1;
  expect(rc.activateAchievement(1, '0xH0010=1') === 0, 'a valid condition activates');
  const first = frame();
  expect(!triggered(first, 1), 'true on its first frame, it does not trigger (it waits)');
  ram[0x10] = 0; frame();
  ram[0x10] = 1;
  const later = frame();
  expect(triggered(later, 1), 'after being false once, it triggers when true');
  expect(!triggered(frame(), 1), 'a triggered achievement does not trigger again');
  ok('the waiting state, and triggering once');
}

// 3. Syntax: hit counts, deltas, AddSource with multipliers, nibbles, AND.
{
  rc.clear(); ram.fill(0); frame();
  rc.activateAchievement(2, '0xH0020=1.3.');
  frame();                                   // false: out of waiting
  ram[0x20] = 1;
  const hits = [frame(), frame(), frame()];
  expect(!triggered(hits[0], 2) && !triggered(hits[1], 2) && triggered(hits[2], 2), 'a hit count of 3 triggers on the third true frame');

  rc.activateAchievement(3, '0xH0030=5_d0xH0030=4');
  ram[0x30] = 4; frame(); frame();
  ram[0x30] = 5;
  expect(triggered(frame(), 3), 'a delta condition sees the previous frame: 4 then 5 triggers');
  expect(!triggered(frame(), 3), 'and only on the change');

  rc.activateAchievement(4, 'A:0xH0040*10_0xH0041=25');
  ram[0x40] = 0; frame();
  ram[0x40] = 2; ram[0x41] = 5;
  expect(triggered(frame(), 4), 'AddSource sums: 2*10 + 5 = 25');

  rc.activateAchievement(5, '0xL0050=9_0xU0050=3');
  ram[0x50] = 0; frame();
  ram[0x50] = 0x39;
  expect(triggered(frame(), 5), '0xL reads the low nibble and 0xU the high one ($39: 9 and 3)');

  expect(rc.activateAchievement(6, 'this is not logic') !== 0, 'a malformed condition is refused with an error code');
  ok('hit counts, deltas, AddSource, nibbles and parse errors');
}

// 4. Leaderboards: start, value updates, submit; and cancel.
{
  rc.clear(); ram.fill(0); frame();
  const def = 'STA:0xH0060=1::CAN:0xH0061=1::SUB:0xH0062=1::VAL:0xH0063';
  expect(rc.activateLeaderboard(1, def) === 0, 'a four-part definition activates');
  frame();
  ram[0x60] = 1; ram[0x63] = 7;
  const started = frame();
  expect(has(started, EVENT.LBOARD_STARTED, 1), 'the start condition starts it');
  ram[0x60] = 0; ram[0x63] = 9;
  const updated = frame();
  expect(updated.some((e) => e.type === EVENT.LBOARD_UPDATED && e.id === 1 && e.value === 9), 'a running leaderboard reports its value as it changes');
  ram[0x62] = 1;
  const submitted = frame();
  expect(submitted.some((e) => e.type === EVENT.LBOARD_TRIGGERED && e.id === 1 && e.value === 9), 'the submit condition submits the current value');
  ram[0x62] = 0; frame();
  ram[0x60] = 1; frame(); ram[0x60] = 0;
  ram[0x61] = 1;
  expect(has(frame(), EVENT.LBOARD_CANCELED, 1), 'the cancel condition cancels a running attempt');
  ok('leaderboards start, update, submit and cancel');
}

// 5. Formats (rcheevos format.c).
{
  expect(rc.formatValue(1234, 'SCORE') === '001234', `SCORE is six digits, zero-padded (got ${rc.formatValue(1234, 'SCORE')})`);
  expect(rc.formatValue(42, 'VALUE') === '42', 'VALUE is the number as it is');
  ok('value formats');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - rcheevos: ${testNo} runtime, leaderboard, hash and format checks`);
