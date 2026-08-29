// Open-bus $DE00-$DFFF spec.
//
// Per Bauer + VIC-Addendum: IO1 ($DE00-$DEFF) and IO2 ($DF00-$DFFF) are
// connected to the CPU data bus but have no internal pull-up. With no
// cartridge driving them, a CPU read samples whatever was last on the
// external data bus (`memory.externalDataBus8`).
//
// The latch is updated by:
//   - every CPU read of a driven address (RAM, ROM, I/O register)
//   - every CPU write
//   - every VIC chip-bus fetch (sets it during phi1)
//
// In `disabled` mode the historical 0xFF is returned for back-compat.

import { Memory } from '../src/memory.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function makeMem() {
  const mem = new Memory();
  // Place known data in low RAM so reads drive the latch with predictable bytes.
  for (let i = 0; i < 0x1000; i++) mem.ram[i] = (i & 0xFF) ^ 0x55;
  return mem;
}

// 1. After CPU read of a RAM location, an open-bus read at $DE00 returns the
//    same byte.
{
  const mem = makeMem();
  mem.ram[0x4000] = 0xA5;
  const driven = mem.read(0x4000);
  expect(driven === 0xA5, `expected driven 0xA5, got 0x${driven.toString(16)}`);
  const open = mem.read(0xDE00);
  expect(open === 0xA5, `expected open-bus 0xA5, got 0x${open.toString(16)}`);
  ok('$DE00 returns last CPU-read byte');
}

// 2. After CPU write, open-bus read at $DF12 returns the written byte.
{
  const mem = makeMem();
  mem.write(0x2000, 0x6E);
  const open = mem.read(0xDF12);
  expect(open === 0x6E, `expected 0x6E, got 0x${open.toString(16)}`);
  ok('$DF12 returns last CPU-write byte');
}

// 3. Simulated VIC chip-bus fetch (set latch directly) leaks into $DE5C.
{
  const mem = makeMem();
  mem.externalDataBus8 = 0xC3;
  const open = mem.read(0xDE5C);
  expect(open === 0xC3, `expected 0xC3, got 0x${open.toString(16)}`);
  ok('$DE5C returns prior VIC-fetched byte');
}

// 4. openBusMode='disabled' restores legacy 0xFF behavior.
{
  const mem = makeMem();
  mem.openBusMode = 'disabled';
  mem.externalDataBus8 = 0x42;
  const open = mem.read(0xDE00);
  expect(open === 0xFF, `disabled mode should return 0xFF, got 0x${open.toString(16)}`);
  ok('openBusMode=disabled returns 0xFF');
}

// 5. The open-bus read itself updates the latch (the read drives the bus).
{
  const mem = makeMem();
  mem.externalDataBus8 = 0x77;
  const v = mem.read(0xDE00);
  expect(v === 0x77, `expected 0x77, got 0x${v.toString(16)}`);
  expect(mem.externalDataBus8 === 0x77, `latch should remain 0x77, got 0x${mem.externalDataBus8.toString(16)}`);
  ok('open read leaves latch consistent');
}

if (testsFailing === 0) console.log(`\nAll ${testNo} tests passed.`);
else { console.log(`\n${testsFailing}/${testNo} tests FAILED.`); process.exit(1); }
