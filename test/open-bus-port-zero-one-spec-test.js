// $0000/$0001 RAM-under-port write quirk spec.
//
// The 6510 maps its on-chip I/O port at $0000 (DDR) / $0001 (data). On a
// write to either, the CPU's data-bus drivers stay tri-stated (the port is
// internal). R/W goes low, so the byte the VIC drove during phi1 of the
// same cycle ends up in the underlying RAM. Software reading $00/$01 still
// sees the masked port value (handled by the read path), but tools that
// peek `ram[0]` / `ram[1]` see the leaked VIC byte.

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

// RAM under the data port holds the VIC byte; the port latches CPU data.
{
  const mem = new Memory();
  mem.externalDataBus8 = 0x99;
  mem.write(0x0001, 0x30);
  expect(mem.cpuPort === 0x30, `6510 port latches all CPU data bits regardless of DDR, got 0x${mem.cpuPort.toString(16)}`);
  expect(mem.externalDataBus8 === 0x99, `6510 port writes leave the external bus undriven`);
  expect(mem.ram[0x01] === 0x99, `ram[0x01]: expected VIC byte 0x99, got 0x${mem.ram[0x01].toString(16)}`);
  ok('ram[0x01] holds VIC phi1 byte');
}

// RAM under the DDR also holds the VIC byte.
{
  const mem = new Memory();
  mem.externalDataBus8 = 0x55;
  mem.write(0x0000, 0xFF);  // CPU writes 0xFF to DDR
  expect(mem.cpuDDR === 0xFF, `cpuDDR should still update from CPU data: expected 0xFF, got 0x${mem.cpuDDR.toString(16)}`);
  expect(mem.ram[0x00] === 0x55, `ram[0x00]: expected VIC byte 0x55, got 0x${mem.ram[0x00].toString(16)}`);
  ok('ram[0x00] holds VIC phi1 byte on DDR write');
}

if (testsFailing === 0) console.log(`\nAll ${testNo} tests passed.`);
else { console.log(`\n${testsFailing}/${testNo} tests FAILED.`); process.exit(1); }
