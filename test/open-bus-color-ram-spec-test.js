// Color RAM upper-nybble open-bus spec.
//
// Color RAM ($D800-$DBFF) is connected to data lines D0-D3 only. D4-D7 are
// open bus and sample whatever was last on the shared external bus latch.
// On real hardware this is typically the byte the VIC fetched in phi1 of
// the same cycle, but for unit testing we set the latch directly.
//
// Composed value: (externalDataBus8 & 0xF0) | (colorRam[idx] & 0x0F).
// A read re-drives the shared latch with the composed byte.

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

// Stub VIC2 so the $D000-$D3FF and $D400-$D7FF reads don't blow up — we
// only care about $D800-$DBFF here.
class StubChip { read() { return 0; } write() {} }

function makeMem() {
  const mem = new Memory();
  mem.vic2 = new StubChip();
  mem.sid = new StubChip();
  mem.cia1 = new StubChip();
  mem.cia2 = new StubChip();
  return mem;
}

// Composed read: latch high nybble + Color RAM low nybble.
{
  const mem = makeMem();
  mem.colorRam[0x000] = 0x07;
  mem.externalDataBus8 = 0xB3;
  const v = mem.read(0xD800);
  expect(v === 0xB7, `expected 0xB7, got 0x${v.toString(16)}`);
  ok('Color RAM upper nybble samples latch');
}

// Latched value re-drives the bus after composed read.
{
  const mem = makeMem();
  mem.colorRam[0x100] = 0x0A;
  mem.externalDataBus8 = 0x90;
  mem.read(0xD900);
  expect(mem.externalDataBus8 === 0x9A, `latch should be 0x9A, got 0x${mem.externalDataBus8.toString(16)}`);
  ok('composed read re-drives latch');
}

// Write masks to low nybble unchanged.
{
  const mem = makeMem();
  mem.write(0xDB00, 0xA9);
  expect((mem.colorRam[0x300] & 0xFF) === 0x09, `expected stored 0x09, got 0x${mem.colorRam[0x300].toString(16)}`);
  ok('Color RAM write stores low nybble only');
}

if (testsFailing === 0) console.log(`\nAll ${testNo} tests passed.`);
else { console.log(`\n${testsFailing}/${testNo} tests FAILED.`); process.exit(1); }
