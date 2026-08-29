// CIA SDR (serial shift register) spec audit. 10 tests derived from the
// MOS6526 datasheet §3.3 (serial port).
//
// SDR ($DC0C / $DD0C):
//   - In INPUT mode (CRA bit 6 = 0): SDR fills with bits clocked in on
//     CNT pin, sampled on rising edges of CNT. After 8 bits, SP IRQ (ICR
//     bit 3) raises and the byte is in SDR.
//   - In OUTPUT mode (CRA bit 6 = 1): writing SDR primes the shift
//     register. Each Timer A underflow shifts out one half-bit on CNT;
//     16 underflows = 8 bits = SP IRQ.
//   - Switching CRA bit 6 from output→input cancels active shifting.

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

// ── 1: SDR write in OUTPUT mode arms shifting ──────────────────────────
{
  const cia = new CIA(1);
  cia.write(0x0E, 0x40);     // CRA bit 6 = 1 (output mode)
  expect(cia._sdrShifting === false, `pre: shifting not yet armed`);
  cia.write(0x0C, 0x55);     // SDR write while in output mode
  expect(cia._sdrShifting === true,
    `SDR write in output mode must arm shifting`);
  expect(cia.sdr === 0x55, `SDR register holds primed byte`);
  ok('MOS6526: SDR write in output mode arms shifting');
}

// ── 2: SDR write in INPUT mode does NOT arm shifting ───────────────────
{
  const cia = new CIA(1);
  cia.write(0x0E, 0x00);     // CRA bit 6 = 0 (input mode)
  cia.write(0x0C, 0xAA);
  expect(cia._sdrShifting === false,
    `SDR write in input mode must NOT arm shifting`);
  ok('MOS6526: SDR write in input mode is a no-op for the shifter');
}

// ── 3: SP IRQ (ICR bit 3) fires after 16 TA underflows ─────────────────
// Datasheet: in output mode, each TA underflow shifts a half-bit on CNT.
// 16 underflows = 8 full bits → SP IRQ. With latch=1 (TA underflows
// every 2 cycles), 16 underflows happen in ~32 cycles.
{
  let irq = false;
  const cia = new CIA(1);
  cia.irqHandler = () => { irq = true; };
  cia.write(0x04, 0x01); cia.write(0x05, 0x00);   // TA latch=1
  cia.write(0x0D, 0x88);                            // ICR enable SP (bit 3)
  cia.write(0x0E, 0x51);                            // CRA: start, force-load, output mode
  cia.write(0x0C, 0xFF);                            // SDR write → arm
  for (let c = 0; c < 50; c++) cia.clock(1);
  expect(irq === true,
    `SP IRQ must fire after 16 TA underflows (≈32 cycles), got ${cia._sdrCount} underflow halves`);
  ok('MOS6526: SP IRQ fires after 16 TA underflows in output mode');
}

// ── 4: After SP IRQ fires, shifting stops (no pending byte) ────────────
{
  const cia = new CIA(1);
  cia.write(0x04, 0x01); cia.write(0x05, 0x00);
  cia.write(0x0D, 0x88);
  cia.write(0x0E, 0x51);
  cia.write(0x0C, 0xFF);
  for (let c = 0; c < 50; c++) cia.clock(1);
  expect(cia._sdrShifting === false,
    `after 8-bit shift completes: _sdrShifting must clear`);
  expect(cia._sdrPending === false, `no pending byte queued`);
  ok('MOS6526: shift completes → _sdrShifting clears');
}

// ── 5: SDR write during active shift queues pending byte ───────────────
// Datasheet: writing SDR while a shift is in progress does NOT interrupt
// it. The next byte is queued and starts shifting after the current one
// completes.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x10); cia.write(0x05, 0x00);   // slow TA
  cia.write(0x0E, 0x51);
  cia.write(0x0C, 0xAA);                            // first byte
  expect(cia._sdrShifting === true && cia._sdrPending === false,
    `pre: shifting active, no pending`);
  // Run a few cycles (incomplete shift) and write again.
  for (let c = 0; c < 10; c++) cia.clock(1);
  cia.write(0x0C, 0x55);                            // second byte
  expect(cia._sdrPending === true,
    `SDR write during active shift queues pending`);
  ok('MOS6526: SDR write during shift queues pending byte');
}

// ── 6: Pending byte takes over after current shift completes ───────────
{
  let irqs = 0;
  const cia = new CIA(1);
  cia.irqHandler = () => { irqs++; };
  cia.write(0x04, 0x01); cia.write(0x05, 0x00);
  cia.write(0x0D, 0x88);
  cia.write(0x0E, 0x51);
  cia.write(0x0C, 0xAA);
  // Queue pending early.
  for (let c = 0; c < 5; c++) cia.clock(1);
  cia.write(0x0C, 0x55);
  // Run long enough for both bytes (32+32 cycles).
  for (let c = 0; c < 80; c++) cia.clock(1);
  expect(cia._sdrShifting === false,
    `after both bytes shift: _sdrShifting clears`);
  ok('MOS6526: pending byte chains to next shift after first completes');
}

// ── 7: Switching SP output→input cancels active shift ──────────────────
{
  const cia = new CIA(1);
  cia.write(0x04, 0x10); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x51);
  cia.write(0x0C, 0xFF);
  expect(cia._sdrShifting === true, `pre: shifting`);
  cia.write(0x0E, 0x11);     // CRA bit 6 = 0 (input mode)
  expect(cia._sdrShifting === false,
    `SP output→input switch must cancel active shift`);
  expect(cia._sdrPending === false, `pending byte also cleared`);
  ok('MOS6526: SP output→input switch cancels active shift');
}

// ── 8: SP input→output does NOT auto-start shifting ────────────────────
{
  const cia = new CIA(1);
  cia.write(0x0E, 0x00);     // CRA: input
  cia.write(0x0C, 0xAA);     // SDR write in input → no arm
  cia.write(0x0E, 0x40);     // switch to output
  expect(cia._sdrShifting === false,
    `input→output switch does NOT retroactively arm shifting`);
  ok('MOS6526: input→output switch does not retroactively arm shifting');
}

// ── 9: SDR read returns the SDR register byte ──────────────────────────
{
  const cia = new CIA(1);
  cia.sdr = 0x42;
  expect(cia.read(0x0C) === 0x42,
    `SDR read returns register value, got $${cia.read(0x0C).toString(16)}`);
  ok('MOS6526: SDR ($DC0C) read returns the register byte');
}

// ── 10: SP IRQ does not fire if ICR mask bit 3 is clear ────────────────
// `irqHandler(state)` is called with the live IRQ state; we track only
// asserting transitions so a deassert tick doesn't count as an IRQ.
{
  let irqAsserted = false;
  const cia = new CIA(1);
  cia.irqHandler = (state) => { if (state) irqAsserted = true; };
  cia.write(0x04, 0x01); cia.write(0x05, 0x00);
  cia.write(0x0D, 0x80);                            // mask bit 3 = 0 (no SP IRQ)
  cia.write(0x0E, 0x51);
  cia.write(0x0C, 0xFF);
  for (let c = 0; c < 50; c++) cia.clock(1);
  expect(irqAsserted === false,
    `SP IRQ must NOT assert IRQ line when ICR mask bit 3 = 0`);
  // ICR status bit 3 still SETS (per datasheet, status latches regardless
  // of mask) — but the IRQ line stays low.
  expect((cia.icrStatus & 0x08) !== 0,
    `ICR status bit 3 latches even when mask is 0`);
  ok('MOS6526: SP IRQ line gated by ICR mask bit 3, status still latches');
}

// ── Reset clears the shift state ────────────────────────────────────────
{
  const cia = new CIA(1);
  cia.write(0x04, 0x04); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x40); cia.write(0x0C, 0xFF);
  cia.write(0x0D, 0x88); cia.read(0x0D);
  cia.write(0x0E, 0x41);
  for (let i = 0; i < 20; i++) cia.clock(1);         // mid-shift
  cia.reset();
  cia.write(0x04, 0x04); cia.write(0x05, 0x00);
  cia.write(0x0D, 0x88); cia.read(0x0D);
  cia.write(0x0E, 0x41);                             // timer runs, nothing armed
  for (let i = 0; i < 200; i++) cia.clock(1);
  expect((cia.read(0x0D) & 0x08) === 0, 'no spurious SP IRQ after reset');
  ok('MOS6526: reset clears an in-progress SDR shift');
}

console.log(`\n${testNo} CIA SDR spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
