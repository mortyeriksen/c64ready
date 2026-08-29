// MOS 6522 VIA timer / IRQ spec audit. 10 tests derived from the 6522
// datasheet — Timer 1 / Timer 2 cycle behavior, ACR continuous mode,
// IFR latching, IER masking. Used by the 1541 disk drive's controller
// scheduler.

import { VIA6522 } from '../src/6522.js';

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

// ── 1: Writing $05 (T1CH) loads counter and starts the timer ────────────
{
  const via = new VIA6522('test');
  via.write(0x04, 0x10);             // T1L lo
  via.write(0x05, 0x00);             // T1CH = 0 → counter = $0010 + 1 = $0011, start
  expect(via.t1c === 0x11, `T1 counter loaded with latch+1 ($11), got $${via.t1c.toString(16)}`);
  expect(via.t1_active === true, `T1 must be active`);
  ok('6522: T1CH write loads counter (latch+1) and starts T1');
}

// ── 2: T1 counts down 1 per clock ──────────────────────────────────────
{
  const via = new VIA6522('test');
  via.write(0x04, 0x10);
  via.write(0x05, 0x00);
  via.clock(5);
  expect(via.t1c === 0x11 - 5,
    `T1 must decrement by 5, got $${via.t1c.toString(16)}`);
  ok('6522: T1 decrements 1 per clock cycle');
}

// ── 3: T1 underflow sets IFR bit 6 ─────────────────────────────────────
{
  const via = new VIA6522('test');
  via.write(0x04, 0x05);
  via.write(0x05, 0x00);             // counter = 6
  via.clock(7);                       // exhaust + 1 to trigger underflow
  expect((via.ifr & 0x40) !== 0,
    `T1 underflow must set IFR bit 6, got IFR=$${via.ifr.toString(16)}`);
  ok('6522: T1 underflow latches IFR bit 6');
}

// ── 4: T1 continuous mode (ACR bit 6 = 1) reloads from latch ───────────
{
  const via = new VIA6522('test');
  via.write(0x0B, 0x40);             // ACR bit 6 = 1 (continuous)
  via.write(0x04, 0x02);
  via.write(0x05, 0x00);             // counter=3, continuous
  for (let i = 0; i < 10; i++) via.clock(1);
  expect(via.t1_active === true,
    `T1 continuous mode must stay active across multiple underflows`);
  ok('6522: T1 continuous mode (ACR.6=1) keeps running');
}

// ── 5: T1 one-shot mode (ACR bit 6 = 0) auto-stops after underflow ─────
{
  const via = new VIA6522('test');
  via.write(0x0B, 0x00);             // ACR bit 6 = 0 (one-shot)
  via.write(0x04, 0x02);
  via.write(0x05, 0x00);
  via.clock(10);
  expect(via.t1_active === false,
    `T1 one-shot must clear t1_active after underflow`);
  ok('6522: T1 one-shot (ACR.6=0) auto-stops on underflow');
}

// ── 6: T2 one-shot underflow sets IFR bit 5 ─────────────────────────────
{
  const via = new VIA6522('test');
  via.write(0x08, 0x05);             // T2L lo
  via.write(0x09, 0x00);             // T2CH → counter = $0005, start
  via.clock(10);
  expect((via.ifr & 0x20) !== 0,
    `T2 underflow must set IFR bit 5, got IFR=$${via.ifr.toString(16)}`);
  expect(via.t2_active === false,
    `T2 is one-shot only — must auto-stop`);
  ok('6522: T2 underflow latches IFR bit 5 and stops (one-shot only)');
}

// ── 7: IFR is write-1-to-clear ─────────────────────────────────────────
// Writing 1 to a bit in $0D clears that bit.
{
  const via = new VIA6522('test');
  via.ifr = 0x40 | 0x20;              // T1 + T2 IRQs latched
  via.write(0x0D, 0x40);              // clear T1
  expect((via.ifr & 0x40) === 0, `IFR bit 6 cleared by W1C`);
  expect((via.ifr & 0x20) !== 0, `IFR bit 5 still set (only T1 cleared)`);
  ok('6522: IFR ($0D) is write-1-to-clear per bit');
}

// ── 8: IER write with bit 7 = 1 sets enable bits ────────────────────────
{
  const via = new VIA6522('test');
  via.write(0x0E, 0x80 | 0x40);       // bit 7 = 1, set bit 6
  expect((via.ier & 0x40) === 0x40,
    `IER write with bit 7 = 1: bits 0..6 are SET`);
}
// Following test below.
ok('6522: IER write with bit 7 = 1 sets enable bits');

// ── 9: IER write with bit 7 = 0 clears enable bits ─────────────────────
{
  const via = new VIA6522('test');
  via.ier = 0x7F;                     // all enabled
  via.write(0x0E, 0x00 | 0x40);       // bit 7 = 0, clear bit 6
  expect((via.ier & 0x40) === 0,
    `IER write with bit 7 = 0: bits 0..6 are CLEARED`);
  ok('6522: IER write with bit 7 = 0 clears enable bits');
}

// ── 10: irqHandler called with current irq state on IFR/IER changes ────
{
  let irqState = false;
  const via = new VIA6522('test');
  via.irqHandler = (s) => { irqState = s; };
  via.ier = 0x40;                     // T1 IRQ enabled
  via.triggerIrq(6);                   // T1 fires
  expect(irqState === true,
    `irqHandler must be called with true when T1 fires + enabled`);
  via.clearIrq(6);
  expect(irqState === false,
    `irqHandler must be called with false when IRQ clears`);
  ok('6522: irqHandler signals current IRQ state on IFR/IER changes');
}

// ── 11: peek() reads every register without touching IFR ───────────────
{
  const via = new VIA6522('test');
  via.pinsA = 0xC3; via.pinsB = 0xA5;
  via.write(0x02, 0x0F);              // DDRB: low nibble out
  via.write(0x03, 0xF0);              // DDRA: high nibble out
  via.write(0x00, 0x35);              // ORB
  via.write(0x01, 0x5A);              // ORA
  via.write(0x04, 0x34); via.write(0x05, 0x12);   // T1 = $1234, running
  via.write(0x08, 0x78); via.write(0x09, 0x56);   // T2 = $5678, running
  via.write(0x0A, 0x99);              // SR
  via.write(0x0B, 0x40);              // ACR
  via.write(0x0C, 0x0E);              // PCR
  via.ier = 0x40;
  via.triggerIrq(6);                  // T1 flag up, IRQ asserted
  const ifr = via.ifr;
  expect((ifr & 0xC0) === 0xC0, `pre-condition: T1 flag + IRQ bit set, got $${ifr.toString(16)}`);

  expect(via.peek(0x00) === ((0x35 & 0x0F) | (0xA5 & 0xF0)), `IRB peek mixes ORB outputs with pin inputs, got $${via.peek(0x00).toString(16)}`);
  expect(via.peek(0x01) === 0xC3 && via.peek(0x0F) === 0xC3, 'IRA peek (both addresses) defers to the port-A reader');
  expect(via.peek(0x02) === 0x0F && via.peek(0x03) === 0xF0, 'DDRB / DDRA peek');
  expect(via.peek(0x04) === (via.t1c & 0xFF) && via.peek(0x05) === ((via.t1c >> 8) & 0xFF), 'T1 counter peek');
  expect(via.peek(0x06) === 0x34 && via.peek(0x07) === 0x12, 'T1 latch peek');
  expect(via.peek(0x08) === (via.t2c & 0xFF) && via.peek(0x09) === ((via.t2c >> 8) & 0xFF), 'T2 counter peek');
  expect(via.peek(0x0A) === 0x99 && via.peek(0x0B) === 0x40 && via.peek(0x0C) === 0x0E, 'SR / ACR / PCR peek');
  expect(via.peek(0x0D) === ifr, 'IFR peek returns the flags');
  expect(via.peek(0x0E) === (0x40 | 0x80), 'IER peek has bit 7 set, as on the chip');
  expect(via.ifr === ifr, 'peeking T1 and IFR clears nothing');
  expect(via.peek(0x14) === via.peek(0x04), 'the register index wraps at 16');
  ok('6522: peek() mirrors every register without side effects');
}

// ── 12: a custom port-A reader answers IRA reads (both addresses) ───────
{
  const via = new VIA6522('test');
  let reads = 0;
  via.readPortA = () => { reads++; return 0x3C; };
  via.triggerIrq(1);                  // CA1 flag
  expect(via.read(0x01) === 0x3C, 'IRA read defers to the hook');
  expect((via.ifr & 0x03) === 0, 'reading IRA ($01) clears the CA1/CA2 flags');
  via.triggerIrq(1);
  expect(via.read(0x0F) === 0x3C, 'IRA at $0F reads the same value');
  expect((via.ifr & 0x02) !== 0, 'but the no-handshake address leaves the flags alone');
  expect(reads === 2, `the hook answered both reads (${reads})`);
  ok('6522: IRA reads go through the port-A hook');
}

// ── 13: the shift register is plain storage ─────────────────────────────
{
  const via = new VIA6522('test');
  via.write(0x0A, 0xA7);
  expect(via.read(0x0A) === 0xA7 && via.regs[0x0A] === 0xA7, 'SR write is readable back');
  ok('6522: SR holds what was written');
}

console.log(`\n${testNo} 6522 VIA spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
