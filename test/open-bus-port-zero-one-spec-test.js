// $0000/$0001 RAM-under-port write quirk spec.
//
// The 6510 maps its on-chip I/O port at $0000 (DDR) / $0001 (data). On a
// write to either, the CPU's data-bus drivers stay tri-stated (the port is
// internal). R/W goes low, so the byte the VIC drove during phi1 of the
// same cycle ends up in the underlying RAM. Software reading $00/$01 still
// sees the masked port value (handled by the read path), but tools that
// peek `ram[0]` / `ram[1]` see the leaked VIC byte.
//
// This is gated by `openBusWritesToZeroOneEnabled` because it is obscure
// and most tooling assumes ram[$00/$01] mirrors the port.

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

// 1. Flag off (the legacy model): ram[0x01] tracks the masked port value.
{
  const mem = new Memory();
  mem.openBusWritesToZeroOneEnabled = false;
  mem.externalDataBus8 = 0x99;        // simulate VIC phi1 byte
  mem.write(0x0001, 0x30);            // CPU writes $30 to $01
  const expectedPort = (0x30 & mem.cpuDDR) | (mem.cpuPort & ~mem.cpuDDR);
  expect(mem.cpuPort === expectedPort, `cpuPort: expected 0x${expectedPort.toString(16)}, got 0x${mem.cpuPort.toString(16)}`);
  expect(mem.ram[0x01] === mem.cpuPort, `ram[0x01]: should mirror cpuPort, got 0x${mem.ram[0x01].toString(16)}`);
  ok('flag off: ram[0x01] mirrors port');
}

// 2. Flag on: ram[0x01] gets the VIC phi1 byte; cpuPort still gets masked write.
{
  const mem = new Memory();
  mem.openBusWritesToZeroOneEnabled = true;
  mem.externalDataBus8 = 0x99;
  const ddrBefore = mem.cpuDDR;
  const portBefore = mem.cpuPort;
  mem.write(0x0001, 0x00);
  const expectedPort = (0x00 & ddrBefore) | (portBefore & ~ddrBefore);
  expect(mem.cpuPort === expectedPort, `cpuPort should update normally: expected 0x${expectedPort.toString(16)}, got 0x${mem.cpuPort.toString(16)}`);
  expect(mem.ram[0x01] === 0x99, `ram[0x01]: expected VIC byte 0x99, got 0x${mem.ram[0x01].toString(16)}`);
  ok('flag on: ram[0x01] holds VIC phi1 byte');
}

// 3. Flag on + write to $00: ram[0x00] also gets the VIC byte.
{
  const mem = new Memory();
  mem.openBusWritesToZeroOneEnabled = true;
  mem.externalDataBus8 = 0x55;
  mem.write(0x0000, 0xFF);  // CPU writes 0xFF to DDR
  expect(mem.cpuDDR === 0xFF, `cpuDDR should still update from CPU data: expected 0xFF, got 0x${mem.cpuDDR.toString(16)}`);
  // ram[0x00] is not touched by the legacy path — only by the quirk.
  // Note: in the default path ram[0x00] is left alone (DDR isn't shadowed),
  // so we don't have a flag-off baseline to compare; the quirk simply
  // leaves the byte in RAM.
  expect(mem.ram[0x00] === 0x55, `ram[0x00]: expected VIC byte 0x55, got 0x${mem.ram[0x00].toString(16)}`);
  ok('flag on: ram[0x00] holds VIC phi1 byte on DDR write');
}

if (testsFailing === 0) console.log(`\nAll ${testNo} tests passed.`);
else { console.log(`\n${testsFailing}/${testNo} tests FAILED.`); process.exit(1); }
