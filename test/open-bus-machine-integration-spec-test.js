// Integration test for shared external-data-bus model.
//
// Wires a real C64Machine and exercises:
//   - VIC chip-bus fetches feed memory.externalDataBus8
//   - CPU open-bus reads at $DE00 see the VIC's most recent phi1 byte
//   - Per-cycle bus trace records phi2 owner / latches
//
// Uses only the public C64Machine API; no monkey-patching.

import { C64Machine } from '../src/machine.js';

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

function makeMachine() {
  const m = new C64Machine();
  // Minimal init: zero out the reset vector path so cpu.reset() doesn't
  // throw on missing ROMs. We don't need the KERNAL for these tests.
  m.mem.ram[0xFFFC] = 0x00;
  m.mem.ram[0xFFFD] = 0x10;
  for (let i = 0; i < 0x1000; i++) m.mem.ram[0x1000 + i] = 0xEA; // NOP fill
  m.cpu.reset();
  for (let i = 0; i < 7; i++) m.cpu.clock();
  m.cpu.I = 0;
  return m;
}

// 1. VIC chip-bus fetch lands in memory.externalDataBus8.
{
  const m = makeMachine();
  // Put a known byte in VIC-visible RAM. Bank 0, addr 0x0400 = $0400.
  m.mem.ram[0x0400] = 0xA5;
  // Trigger a VIC fetch directly via the chip-bus helper.
  const v = m.vic2._vicBusRead(0x0400, 0x0000);
  expect(v === 0xA5, `expected fetched 0xA5, got 0x${v.toString(16)}`);
  expect(m.mem.externalDataBus8 === 0xA5, `external bus: expected 0xA5, got 0x${m.mem.externalDataBus8.toString(16)}`);
  expect(m.vic2.vicInternalBus === 0xA5, `vic internal bus: expected 0xA5, got 0x${m.vic2.vicInternalBus.toString(16)}`);
  ok('VIC fetch drives shared external bus');
}

// 2. After a VIC fetch, an open-bus CPU read at $DE00 returns that byte.
{
  const m = makeMachine();
  m.mem.ram[0x0500] = 0xC9;
  m.vic2._vicBusRead(0x0500, 0x0000);
  const open = m.mem.read(0xDE00);
  expect(open === 0xC9, `expected open 0xC9, got 0x${open.toString(16)}`);
  ok('CPU open-read at $DE00 sees VIC fetch');
}

// 3. CPU read of Color RAM composes upper nybble from latch.
{
  const m = makeMachine();
  m.mem.colorRam[0x000] = 0x07;
  m.mem.ram[0x0600] = 0xB3;
  m.vic2._vicBusRead(0x0600, 0x0000);   // latch = 0xB3
  const v = m.mem.read(0xD800);
  expect(v === 0xB7, `expected composed 0xB7, got 0x${v.toString(16)}`);
  ok('Color RAM composed with VIC-fetched high nybble');
}

// 4. Bus trace records per-cycle state.
{
  const m = makeMachine();
  m.enableBusTrace(64);
  for (let i = 0; i < 8; i++) m._runMasterCycle();
  const snap = m.busTraceSnapshot();
  expect(snap.length === 8, `expected 8 trace entries, got ${snap.length}`);
  for (const e of snap) {
    expect(typeof e.externalDataBus8 === 'number', 'entry missing externalDataBus8');
    expect(typeof e.vicInternalBus8 === 'number', 'entry missing vicInternalBus8');
    expect(typeof e.phi2Owner === 'string', 'entry missing phi2Owner');
  }
  ok('bus trace records per-cycle state');
}

if (testsFailing === 0) console.log(`\nAll ${testNo} tests passed.`);
else { console.log(`\n${testsFailing}/${testNo} tests FAILED.`); process.exit(1); }
