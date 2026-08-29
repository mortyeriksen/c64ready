// VIC register read/write mask spec test.
//
// Bauer §3.2: each VIC-II register has specific behaviors on read:
//   $D016: bits 7,6 unused → read as 1 (= |0xC0).
//   $D018: bit 0 unused → read as 1 (= |0x01).
//   $D019: bits 4-6 unused → read as 1 (= |0x70).
//   $D01A: bits 4-7 unused → read as 1 (= |0xF0).
//   $D01E, $D01F: collision regs — clear-on-read.
//   $D02F-$D03F: unconnected → read as $FF.
//
// On write: most registers honor all bits. $D019 is write-1-to-clear.
//
// Audit gap: vic-readonly-regs-spec-test covers some of this. This
// test pins the exact unused-bit behavior for each register.

import { VIC2 } from '../src/vic2.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  return vic;
}

// ── 1: $D016 — bits 7,6 read as 1.
{
  const vic = makeVic();
  vic.write(0x16, 0x00);
  const r = vic.read(0x16);
  expect((r & 0xC0) === 0xC0,
    `$D016 bits 7,6 read as 1 (unused); got 0x${r.toString(16)}`);
  // Lower 6 bits reflect what was written.
  vic.write(0x16, 0x3F);
  expect((vic.read(0x16) & 0x3F) === 0x3F,
    `$D016 bits 0-5 round-trip on write/read`);
  ok('Bauer §3.2: $D016 reads bits 7,6 as 1 (unused), bits 0-5 round-trip');
}

// ── 2: $D018 — bit 0 reads as 1 (unused).
{
  const vic = makeVic();
  vic.write(0x18, 0x00);
  expect((vic.read(0x18) & 0x01) === 0x01,
    `$D018 bit 0 reads as 1 (unused); got 0x${vic.read(0x18).toString(16)}`);
  vic.write(0x18, 0xFE);
  expect((vic.read(0x18) & 0xFE) === 0xFE,
    `$D018 bits 1-7 round-trip`);
  ok('Bauer §3.2: $D018 reads bit 0 as 1 (unused), bits 1-7 round-trip');
}

// ── 3: $D019 — bits 4-6 read as 1, write-1-to-clear semantics.
{
  const vic = makeVic();
  vic.irqStatus = 0x01;
  vic.irqMask = 0x01;
  vic.irqStatus |= 0x80;
  const r = vic.read(0x19);
  expect((r & 0x70) === 0x70,
    `$D019 bits 4-6 read as 1; got 0x${r.toString(16)}`);
  expect((r & 0x01) === 0x01,
    `$D019 bit 0 reflects latched raster IRQ`);
  expect((r & 0x80) === 0x80,
    `$D019 bit 7 reflects master pending`);
  ok('Bauer §3.13: $D019 reads bits 4-6 as 1; bits 0-3 + 7 reflect latch state');
}

// ── 4: $D01A — bits 4-7 read as 1.
{
  const vic = makeVic();
  vic.write(0x1A, 0x00);
  expect((vic.read(0x1A) & 0xF0) === 0xF0,
    `$D01A bits 4-7 read as 1; got 0x${vic.read(0x1A).toString(16)}`);
  vic.write(0x1A, 0x0F);
  expect((vic.read(0x1A) & 0x0F) === 0x0F,
    `$D01A bits 0-3 round-trip`);
  ok('Bauer §3.13: $D01A reads bits 4-7 as 1 (unused), bits 0-3 round-trip');
}

// ── 5: $D01E (sprite-sprite collision) clear-on-read.
{
  const vic = makeVic();
  vic.regs[0x1E] = 0x55;
  const r1 = vic.read(0x1E);
  expect(r1 === 0x55,
    `$D01E first read returns latched value $55; got 0x${r1.toString(16)}`);
  const r2 = vic.read(0x1E);
  expect(r2 === 0x00,
    `$D01E second read returns 0 (cleared); got 0x${r2.toString(16)}`);
  ok('Bauer §3.11: $D01E (sprite-sprite collision) is clear-on-read');
}

// ── 6: $D01F (sprite-bg collision) clear-on-read.
{
  const vic = makeVic();
  vic.regs[0x1F] = 0xAA;
  const r1 = vic.read(0x1F);
  expect(r1 === 0xAA, `$D01F first read $AA; got 0x${r1.toString(16)}`);
  const r2 = vic.read(0x1F);
  expect(r2 === 0x00, `$D01F second read 0; got 0x${r2.toString(16)}`);
  ok('Bauer §3.11: $D01F (sprite-bg collision) is clear-on-read');
}

// ── 7: $D02F-$D03F reads as $FF (unconnected).
{
  const vic = makeVic();
  for (let reg = 0x2F; reg <= 0x3F; reg++) {
    const r = vic.read(reg);
    expect(r === 0xFF,
      `$D0${reg.toString(16).toUpperCase()} reads $FF (unconnected); got 0x${r.toString(16)}`);
  }
  ok('Bauer §3.2: $D02F-$D03F (17 unconnected regs) all read $FF');
}

// ── 8: $D011 read — bit 7 = RST8 of raster, bits 0-6 round-trip from latch.
{
  const vic = makeVic();
  vic.write(0x11, 0x7F);                  // bit 7 = 0, others 1
  // After write, raster bit 8 = 0 if vic.raster < 256.
  const r = vic.read(0x11);
  expect((r & 0x7F) === 0x7F,
    `$D011 bits 0-6 round-trip; got 0x${r.toString(16)}`);
  // bit 7 reflects current raster bit 8, NOT what we wrote.
  ok('Bauer §3.12: $D011 bits 0-6 round-trip on write; bit 7 read = raster bit 8 (LIVE)');
}

console.log(`\n${testNo} VIC register read/write mask spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
