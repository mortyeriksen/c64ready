// CIA serial port pins (SP, CNT), from the MOS 6526 datasheet, serial port:
//  - Input mode (CRA bit 6 = 0): SP is shifted in on each rising CNT edge.
//    After 8 edges the shift register is dumped into the SDR and ICR bit 3 is
//    set. The SDR is buffered, so it holds the last complete byte meanwhile.
//  - Output mode (CRA bit 6 = 1): Timer A's underflows clock CNT, which idles
//    high. Each bit appears on SP at a falling CNT edge, MSB first, and stays
//    until the next one. A byte written before the end of the current one
//    follows it without a gap.
// Bit order (MSB first in both directions) is also what the UP9600 driver
// relies on: it reverses every byte before sending and after receiving.

import { CIA } from '../../src/cia.js';

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
const hex = (v) => `$${(v & 0xFF).toString(16).padStart(2, '0')}`;

// Clock a bit in: put it on SP, then one rising CNT edge, then a clock.
function shiftIn(cia, bit) {
  cia.setSp(bit);
  cia.setCnt(0); cia.clock(1);
  cia.setCnt(1); cia.clock(1);
}

// Output mode with Timer A running continuously at latch `n`.
function outputMode(cia, n) {
  cia.write(0x04, n); cia.write(0x05, 0);
  cia.write(0x0E, 0x51);
}

// Run until `bits` bits have appeared on SP, recording SP at each falling CNT edge.
function captureOut(cia, bits) {
  const seen = [];
  let cnt = cia.serialPins() & 2;
  for (let i = 0; i < 10000 && seen.length < bits; i++) {
    cia.clock(1);
    const pins = cia.serialPins();
    if (cnt && !(pins & 2)) seen.push(pins & 1);
    cnt = pins & 2;
  }
  return seen;
}

{
  const cia = new CIA(2);
  for (const bit of [1, 0, 1, 1, 0, 0, 1, 0]) shiftIn(cia, bit);
  expect(cia.read(0x0C) === 0xB2, `8 bits in, first one in bit 7: SDR ${hex(cia.read(0x0C))}, want $b2`);
  expect((cia.read(0x0D) & 0x08) !== 0, 'ICR bit 3 set after the 8th CNT edge');
  ok('input mode: SP shifts in on rising CNT, MSB first, 8 bits fill the SDR');
}

{
  const cia = new CIA(2);
  for (const bit of [0, 1, 0, 1, 0, 1, 0, 1]) shiftIn(cia, bit);
  cia.read(0x0D);
  for (const bit of [1, 1, 1, 1, 0, 0, 0]) shiftIn(cia, bit);
  expect(cia.read(0x0C) === 0x55, `SDR holds the last byte while 7 bits are in: ${hex(cia.read(0x0C))}`);
  expect((cia.read(0x0D) & 0x08) === 0, 'no ICR bit 3 before the 8th edge');
  shiftIn(cia, 1);
  expect(cia.read(0x0C) === 0xF1, `then the new byte: ${hex(cia.read(0x0C))}, want $f1`);
  ok('input mode: the SDR is buffered, it changes only when a byte completes');
}

{
  const cia = new CIA(2);
  cia.setCnt(0);
  for (let i = 0; i < 8; i++) {
    cia.setSp(i & 1);
    cia.setCnt(1); cia.clock(1);
    cia.setCnt(0); cia.clock(1);
  }
  expect((cia.read(0x0D) & 0x08) !== 0, 'edges counted');
  const cia2 = new CIA(2);
  cia2.setCnt(1);
  for (let i = 0; i < 16; i++) { cia2.setSp(i & 1); cia2.clock(1); }
  expect((cia2.read(0x0D) & 0x08) === 0 && cia2.read(0x0C) === 0, 'SP changes with CNT held high shift nothing');
  ok('input mode: only rising CNT edges shift, SP alone does nothing');
}

{
  let irq = false;
  const cia = new CIA(2);
  cia.irqHandler = (s) => { if (s) irq = true; };
  cia.write(0x0D, 0x88);
  for (let i = 0; i < 8; i++) shiftIn(cia, 1);
  cia.clock(1);
  expect(irq, 'a full byte raises the interrupt when ICR bit 3 is enabled');
  ok('input mode: a received byte interrupts through the ICR mask');
}

{
  const cia = new CIA(1);
  cia.write(0x0E, 0x40);
  for (let i = 0; i < 8; i++) shiftIn(cia, 1);
  expect((cia.read(0x0D) & 0x08) === 0, 'CNT edges in output mode shift nothing in');
  ok('output mode: external CNT edges do not shift data in');
}

{
  const cia = new CIA(1);
  expect((cia.serialPins() & 3) === 3, 'input mode leaves SP and CNT to the pull-ups');
  outputMode(cia, 3);
  cia.write(0x0C, 0xA5);
  const bits = captureOut(cia, 8);
  expect(bits.join('') === '10100101', `SP bits at each falling CNT edge: ${bits.join('')}, want 10100101`);
  for (let i = 0; i < 20; i++) cia.clock(1);
  expect((cia.serialPins() & 2) === 2, 'CNT is high again after the byte');
  expect((cia.serialPins() & 1) === 1, 'SP keeps the last bit sent');
  ok('output mode: SDR goes out MSB first, one bit per falling CNT edge');
}

{
  const cia = new CIA(1);
  outputMode(cia, 2);
  let cnt = 1, edges = 0;
  for (let i = 0; i < 60; i++) {
    cia.clock(1);
    const c = (cia.serialPins() >> 1) & 1;
    if (c !== cnt) edges++;
    cnt = c;
  }
  expect(edges === 0, `CNT stays high with nothing to send (${edges} edges)`);
  cia.write(0x0C, 0x80);
  let half = 0, last = 1, changes = [];
  for (let i = 0; i < 80 && changes.length < 4; i++) {
    cia.clock(1);
    half++;
    const c = (cia.serialPins() >> 1) & 1;
    if (c !== last) { changes.push(half); half = 0; }
    last = c;
  }
  expect(changes.slice(1).every((h) => h === 3), `CNT changes once per Timer A underflow (latch 2 = every 3 cycles): ${changes}`);
  ok('output mode: CNT toggles on Timer A underflows only while sending');
}

{
  const cia = new CIA(1);
  outputMode(cia, 4);
  cia.write(0x0C, 0x0F);
  cia.write(0x0C, 0xF0);
  const bits = captureOut(cia, 16);
  expect(bits.join('') === '0000111111110000', `two bytes back to back: ${bits.join('')}`);
  ok('output mode: a byte written during a shift follows it with no gap');
}

{
  const cia = new CIA(1);
  let calls = 0;
  cia.serialPinsChanged = () => { calls++; };
  outputMode(cia, 1);
  cia.write(0x0C, 0xFF);
  for (let i = 0; i < 40; i++) cia.clock(1);
  expect(calls === 16, `one notice per CNT change, SP already high: ${calls}, want 16`);
  calls = 0;
  cia.write(0x0E, 0x01);
  expect(calls === 0, 'switching to input with both pins high changes nothing');
  ok('pin changes are reported only when a level changes');
}

{
  const cia = new CIA(1);
  outputMode(cia, 3);
  cia.write(0x0C, 0x00);
  captureOut(cia, 3);
  const mid = cia.serialPins();
  expect((mid & 1) === 0, 'SP low while sending zeros');
  cia.write(0x0E, 0x11);
  expect((cia.serialPins() & 3) === 3, 'switching to input mode releases SP and CNT');
  ok('input mode releases both pins');
}

console.log(`\n${testNo} CIA serial pin spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
