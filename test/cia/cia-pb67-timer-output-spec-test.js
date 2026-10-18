// CIA timer outputs on PB6 (Timer A) and PB7 (Timer B), from the MOS 6526
// datasheet (CRA/CRB bit 1 PBON, bit 2 OUTMODE) and Lorenz's model of it:
//  - With PBON set the timer drives the pin, whatever DDRB and the port latch say.
//  - Pulse mode: the pin is high for the one cycle of an underflow, low otherwise.
//  - Toggle mode: the pin inverts on each underflow. The toggle flip-flop is set
//    by a rising edge of START (bit 0), cleared by reset, and toggles on every
//    underflow whether or not PBON and OUTMODE are set.

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
const pb6 = (cia) => (cia.read(0x01) >> 6) & 1;
const pb7 = (cia) => (cia.read(0x01) >> 7) & 1;

{
  const cia = new CIA(2);
  cia.write(0x03, 0x00);
  cia.write(0x0E, 0x02);
  cia.write(0x0F, 0x02);
  expect((cia.read(0x01) & 0xC0) === 0, 'pulse mode, timers stopped: PB6 and PB7 read low with DDRB = 0');
  cia.write(0x03, 0xFF); cia.write(0x01, 0xFF);
  expect((cia.read(0x01) & 0xC0) === 0, 'and low over a port latch of $ff');
  cia.write(0x0E, 0x00); cia.write(0x0F, 0x00);
  expect((cia.read(0x01) & 0xC0) === 0xC0, 'PBON clear gives the pins back to the port');
  ok('PBON makes PB6/PB7 timer outputs, overriding DDRB and the latch');
}

{
  const cia = new CIA(1);
  cia.write(0x02, 0xFF); cia.write(0x03, 0x00);
  cia.write(0x00, 0xFF);
  cia.write(0x0E, 0x02); cia.write(0x0F, 0x02);
  expect(cia.read(0x01) === 0x3F, `CIA1 keyboard port: $${cia.read(0x01).toString(16)}, want $3f`);
  ok('CIA1: the timer outputs also override the keyboard row read');
}

{
  const cia = new CIA(2);
  cia.write(0x04, 3); cia.write(0x05, 0);
  cia.write(0x0E, 0x13);                     // load, start, PBON, pulse
  const highs = [];
  for (let i = 0; i < 20; i++) {
    const under = cia.clock(1);
    if (pb6(cia)) highs.push(i);
    expect(pb6(cia) === (under ? 1 : 0), `cycle ${i}: PB6 ${pb6(cia)} but underflow ${under}`);
  }
  expect(highs.length >= 3, `pulses seen at ${highs}`);
  ok('pulse mode: PB6 is high exactly in the cycle Timer A underflows');
}

{
  const cia = new CIA(2);
  cia.write(0x04, 2); cia.write(0x05, 0);
  cia.write(0x0E, 0x17);                     // load, start, PBON, toggle
  expect(pb6(cia) === 1, 'toggle output starts high when the timer starts');
  const levels = [];
  for (let i = 0; i < 12; i++) {
    const before = pb6(cia);
    const under = cia.clock(1);
    expect(pb6(cia) === (under ? before ^ 1 : before), `cycle ${i}: toggles only on underflow`);
    levels.push(pb6(cia));
  }
  expect(levels.includes(0) && levels.includes(1), `toggled: ${levels.join('')}`);
  ok('toggle mode: PB6 inverts on each underflow');
}

{
  const cia = new CIA(2);
  cia.write(0x06, 1); cia.write(0x07, 0);
  cia.write(0x0F, 0x1F);                     // one-shot, load, start, PBON, toggle
  let n = 0;
  while (pb7(cia) === 1 && n++ < 10) cia.clock(1);
  expect(pb7(cia) === 0, 'first underflow takes PB7 low');
  cia.write(0x0F, 0x0E);
  cia.write(0x06, 5); cia.write(0x07, 0);
  cia.write(0x0F, 0x1E);
  expect(pb7(cia) === 0, 'control writes without a START edge and timer writes keep it low');
  cia.write(0x0F, 0x0F);
  expect(pb7(cia) === 1, 'a rising START edge sets it high again');
  ok('toggle flip-flop: only a START rising edge sets it');
}

{
  const cia = new CIA(2);
  cia.write(0x04, 1); cia.write(0x05, 0);
  cia.write(0x0E, 0x11);                     // running, PBON off
  let unders = 0;
  while (unders < 3) if (cia.clock(1)) unders++;
  cia.write(0x0E, 0x07);                     // PBON on, toggle, still running
  expect(pb6(cia) === 0, `toggled 3 times while PBON was off, so PB6 is low: ${pb6(cia)}`);
  ok('the toggle flip-flop counts underflows while PBON is off');
}

{
  const cia = new CIA(2);
  cia.write(0x04, 0); cia.write(0x05, 0);
  cia.write(0x0E, 0x07);
  cia.reset();
  cia.write(0x0E, 0x06);                     // toggle mode, timer stopped
  expect(pb6(cia) === 0, 'reset clears the toggle flip-flop');
  ok('reset clears the toggle output');
}

{
  const cia = new CIA(2);
  cia.write(0x04, 0x02); cia.write(0x05, 0);
  cia.write(0x06, 0x02); cia.write(0x07, 0);
  cia.write(0x0F, 0x47 | 0x10);              // TB counts TA underflows, PBON, toggle
  cia.write(0x0E, 0x13);                     // TA pulse on PB6
  let pb7Changes = 0, last = pb7(cia), tbUnders = 0;
  for (let i = 0; i < 60; i++) {
    const before = cia.icrStatus & 2;
    cia.clock(1);
    if (!before && (cia.icrStatus & 2)) tbUnders++;
    cia.icrStatus &= ~2;
    if (pb7(cia) !== last) pb7Changes++;
    last = pb7(cia);
  }
  expect(tbUnders > 0 && pb7Changes === tbUnders, `PB7 toggles once per Timer B underflow: ${pb7Changes} vs ${tbUnders}`);
  ok('PB7 follows Timer B, also when it counts Timer A underflows');
}

{
  const cia = new CIA(2);
  let calls = 0;
  cia.pbTimerChanged = () => { calls++; };
  cia.write(0x06, 4); cia.write(0x07, 0);
  for (let i = 0; i < 20; i++) cia.clock(1);
  expect(calls === 0, 'nothing reported while PBON is off');
  cia.write(0x0F, 0x13);
  const afterOn = calls;
  let pulses = 0;
  for (let i = 0; i < 25 || (pb7(cia) && i < 50); i++) {
    cia.clock(1);
    if (cia.icrStatus & 2) { pulses++; cia.icrStatus = 0; }
  }
  expect(afterOn === 1, `turning PBON on reports once (PB7 drops low): ${afterOn}`);
  expect(pulses > 0 && calls - afterOn === 2 * pulses, `each pulse reports up and down: ${calls - afterOn} for ${pulses} pulses`);
  ok('PB6/PB7 output changes are reported for the user port');
}

console.log(`\n${testNo} CIA PB6/PB7 timer output spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
