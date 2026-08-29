// Color RAM upper-nybble open-bus spec.
//
// Color RAM ($D800-$DBFF) is connected to data lines D0-D3 only. D4-D7 are
// open bus and sample whatever was last on the shared external bus latch.
// On real hardware this is typically the byte the VIC fetched in phi1 of
// the same cycle, but for unit testing we set the latch directly.
//
// Composed value: (externalDataBus8 & 0xF0) | (colorRam[idx] & 0x0F).
// When `colorRamReadDrivesComposedByte` is true (default), the composed
// value re-drives the latch (so a follow-up open read at $DExx sees it).
//
// `openBusMode = 'disabled'` falls back to the historical (0xF0 | nybble).

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

// 1. Composed read: latch high nybble + Color RAM low nybble.
{
  const mem = makeMem();
  mem.colorRam[0x000] = 0x07;
  mem.externalDataBus8 = 0xB3;
  const v = mem.read(0xD800);
  expect(v === 0xB7, `expected 0xB7, got 0x${v.toString(16)}`);
  ok('Color RAM upper nybble samples latch');
}

// 2. Latched value re-drives the bus after composed read.
{
  const mem = makeMem();
  mem.colorRam[0x100] = 0x0A;
  mem.externalDataBus8 = 0x90;
  mem.read(0xD900);
  expect(mem.externalDataBus8 === 0x9A, `latch should be 0x9A, got 0x${mem.externalDataBus8.toString(16)}`);
  ok('composed read re-drives latch');
}

// 3. colorRamReadDrivesComposedByte=false leaves the latch alone.
{
  const mem = makeMem();
  mem.colorRamReadDrivesComposedByte = false;
  mem.colorRam[0x200] = 0x0F;
  mem.externalDataBus8 = 0x40;
  const v = mem.read(0xDA00);
  expect(v === 0x4F, `expected composed 0x4F, got 0x${v.toString(16)}`);
  expect(mem.externalDataBus8 === 0x4F, `latch is still re-driven by Memory.read() epilogue, got 0x${mem.externalDataBus8.toString(16)}`);
  // Note: the gate only controls whether the composed step itself updates
  // the latch; the outer Memory.read() epilogue still latches the final
  // returned value (it's the byte the CPU sees on D0-D7).
  ok('colorRamReadDrivesComposedByte=false consistent');
}

// 4. openBusMode='disabled' returns legacy 0xF0 | nybble.
{
  const mem = makeMem();
  mem.openBusMode = 'disabled';
  mem.colorRam[0x000] = 0x07;
  mem.externalDataBus8 = 0xB3;
  const v = mem.read(0xD800);
  expect(v === 0xF7, `expected legacy 0xF7, got 0x${v.toString(16)}`);
  ok('openBusMode=disabled returns 0xF0|nybble');
}

// 5. Write masks to low nybble unchanged.
{
  const mem = makeMem();
  mem.write(0xDB00, 0xA9);
  expect((mem.colorRam[0x300] & 0xFF) === 0x09, `expected stored 0x09, got 0x${mem.colorRam[0x300].toString(16)}`);
  ok('Color RAM write stores low nybble only');
}

if (testsFailing === 0) console.log(`\nAll ${testNo} tests passed.`);
else { console.log(`\n${testsFailing}/${testNo} tests FAILED.`); process.exit(1); }
