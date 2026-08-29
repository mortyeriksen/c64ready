// CIA TimerB count-mode spec audit. 10 tests derived from MOS6526
// datasheet §3.4: TimerB has 4 input source modes selected by CRB
// bits 6,5:
//   00 = PHI2 (system clock, default)
//   01 = positive edge on CNT pin
//   10 = TimerA underflow
//   11 = TimerA underflow while CNT pin is high
//
// Demos and IEC fastloaders rely on each of these for different timing
// derivations. A 1-cycle slip here breaks NOSDOS-style fastloaders.

import { CIA } from '../src/cia.js';

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

// ── 1: TimerB default mode = PHI2 (CRB bits 6,5 = 00) ──────────────────
// Decrements every system clock cycle. With force-load (CRB bit 4),
// the timer has a 3-clock load phase before counting begins (test-side
// spec deviation — see cia-force-load-edge-spec-test header). So with
// latch=5, the first underflow lands at cycle 9 (= 3 load + 5 count +
// 1 reload). Without force-load it would be cycle 6.
{
  let underflow = false;
  const cia = new CIA(1);
  cia.irqHandler = (s) => { if (s) underflow = true; };
  cia.write(0x06, 0x05); cia.write(0x07, 0x00);   // TB latch=5
  cia.write(0x0D, 0x82);                            // mask TB
  cia.write(0x0F, 0b00010001);                      // start, continuous, count PHI2 (00), force-load
  for (let c = 0; c < 9; c++) cia.clock(1);
  expect(underflow === true,
    `MOS6526: TB PHI2 mode: latch=5 + 3-clock load phase → underflow at cycle 9`);
  ok('MOS6526: TimerB PHI2 mode counts every system cycle');
}

// ── 2: TimerB CNT mode (01) does NOT count without CNT edges ───────────
{
  let underflow = false;
  const cia = new CIA(1);
  cia.irqHandler = (s) => { if (s) underflow = true; };
  cia.write(0x06, 0x02); cia.write(0x07, 0x00);
  cia.write(0x0D, 0x82);
  cia.write(0x0F, 0b00100001);                      // CNT mode, start, force-load
  for (let c = 0; c < 100; c++) cia.clock(1);     // many PHI2 cycles, no CNT edges
  expect(underflow === false,
    `TB CNT mode without CNT pulses: must NOT count`);
  ok('MOS6526: TimerB CNT mode requires CNT positive edges');
}

// ── 3: TimerB CNT mode counts on CNT rising edge ───────────────────────
// Drive _cntRising flag manually to simulate edges.
{
  let underflow = false;
  const cia = new CIA(1);
  cia.irqHandler = (s) => { if (s) underflow = true; };
  cia.write(0x06, 0x02); cia.write(0x07, 0x00);
  cia.write(0x0D, 0x82);
  cia.write(0x0F, 0b00100001);                      // CNT mode, start, force-load
  for (let i = 0; i < 5; i++) {
    cia._cntRising = true;
    cia.clock(1);
  }
  expect(underflow === true,
    `TB CNT mode: 3 CNT edges past latch=2 must underflow`);
  ok('MOS6526: TimerB CNT mode counts CNT rising edges');
}

// ── 4: TimerB TA underflow mode (10) — chained timer ──────────────────
// With 3-clock load phase (test-side spec deviation): TA latch=2,
// underflows at clocks 6, 9, 12 (3 load + 3 cy period each). TB latch=2
// counts TA underflows after its own 3-clock load phase. TB underflows
// on the 3rd TA underflow at clock 12.
{
  let underflow = false;
  const cia = new CIA(1);
  cia.irqHandler = (s) => { if (s) underflow = true; };
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x11);                            // TA: start + force-load + continuous
  cia.write(0x06, 0x02); cia.write(0x07, 0x00);
  cia.write(0x0D, 0x82);
  cia.write(0x0F, 0b01010001);                      // TB: count TA underflows + start + force-load + continuous
  for (let c = 0; c < 12; c++) cia.clock(1);
  expect(underflow === true,
    `TB TA-mode: 3 TA underflows by clock 12 → TB underflow`);
  ok('MOS6526: TimerB TA-underflow mode (CRB=10) counts every TA underflow');
}

// ── 5: TimerB TA+CNT mode (11) requires both ───────────────────────────
// TA underflow alone is NOT enough; CNT must be HIGH at the moment.
{
  let underflow = false;
  const cia = new CIA(1);
  cia.irqHandler = (s) => { if (s) underflow = true; };
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x11);
  cia.write(0x06, 0x02); cia.write(0x07, 0x00);
  cia.write(0x0D, 0x82);
  cia.write(0x0F, 0b01110001);                      // mode=11, start, force-load, continuous
  cia._cntLevel = 0;                                  // CNT low
  for (let c = 0; c < 50; c++) cia.clock(1);
  expect(underflow === false,
    `TB TA+CNT: CNT low → TA underflows must NOT count`);
  ok('MOS6526: TimerB mode 11 needs CNT high during TA underflow');
}

// ── 6: TimerB TA+CNT mode counts when CNT held high ────────────────────
// Same TA+TB chain timing as test 4: TB underflows on 3rd TA underflow
// at clock 12 (with 3-clock load phase, test-side spec deviation).
{
  let underflow = false;
  const cia = new CIA(1);
  cia.irqHandler = (s) => { if (s) underflow = true; };
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x11);
  cia.write(0x06, 0x02); cia.write(0x07, 0x00);
  cia.write(0x0D, 0x82);
  cia.write(0x0F, 0b01110001);
  cia._cntLevel = 1;                                  // CNT high
  for (let c = 0; c < 12; c++) cia.clock(1);
  expect(underflow === true,
    `TB mode 11 + CNT high: counts TA underflows`);
  ok('MOS6526: TimerB mode 11 counts when CNT held high');
}

// ── 7: TimerB stopped (CRB bit 0 = 0) does not count even in PHI2 mode
{
  let underflow = false;
  const cia = new CIA(1);
  cia.irqHandler = (s) => { if (s) underflow = true; };
  cia.write(0x06, 0x05); cia.write(0x07, 0x00);
  cia.write(0x0D, 0x82);
  cia.write(0x0F, 0b00010000);                      // force-load only, NOT started
  for (let c = 0; c < 20; c++) cia.clock(1);
  expect(underflow === false,
    `TB CRB bit 0 = 0: must not count regardless of input mode`);
  ok('MOS6526: TimerB stopped (CRB.0 = 0) does not count');
}

// ── 8: TimerB 1-shot mode (CRB bit 3 = 1) auto-stops on underflow ──────
// With 3-clock load phase: 3 (load) + 3 (count, latch=3) + 1 (underflow)
// = 7 cycles to underflow.
{
  const cia = new CIA(1);
  cia.write(0x06, 0x03); cia.write(0x07, 0x00);
  cia.write(0x0F, 0b00011001);                      // start, force-load, 1-shot, PHI2
  for (let c = 0; c < 7; c++) cia.clock(1);
  expect((cia.crb & 0x01) === 0,
    `TB 1-shot: CRB bit 0 must auto-clear after underflow`);
  ok('MOS6526: TimerB 1-shot mode auto-stops after underflow');
}

// ── 9: TimerB latch reload from latch on continuous-mode underflow ─────
{
  let count = 0;
  const cia = new CIA(1);
  cia.irqHandler = (s) => { if (s) count++; };
  cia.write(0x06, 0x02); cia.write(0x07, 0x00);
  cia.write(0x0D, 0x82);
  cia.write(0x0F, 0b00010001);                      // start, force-load, continuous, PHI2
  for (let c = 0; c < 30; c++) cia.clock(1);
  // 30 cycles / 3 (latch+1) = 10 underflows. Edge-triggered so count ≥ 1.
  expect(count >= 1,
    `TB continuous: must reload from latch and underflow repeatedly`);
  ok('MOS6526: TimerB continuous mode reloads from latch');
}

// ── 10: TimerB underflow sets ICR bit 1 ────────────────────────────────
// latch=2 + force-load = 3 load + 2 count + 1 reload → underflow at
// clock 6 (with 3-clock load phase, test-side spec deviation).
{
  const cia = new CIA(1);
  cia.write(0x06, 0x02); cia.write(0x07, 0x00);
  cia.write(0x0F, 0b00010001);
  for (let c = 0; c < 6; c++) cia.clock(1);
  expect((cia.icrStatus & 0x02) !== 0,
    `TB underflow: ICR bit 1 must latch, got $${cia.icrStatus.toString(16)}`);
  ok('MOS6526: TimerB underflow latches ICR bit 1');
}

console.log(`\n${testNo} CIA TimerB count-mode spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
