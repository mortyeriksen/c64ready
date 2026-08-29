// MOS 6526 CIA interrupt-acknowledge bug — the ICR data→IR latch and the
// $DC0D-read-races-the-underflow behavior.
//
// Spec source:
//   - MOS 6526 datasheet (https://dn710607.ca.archive.org/0/items/mos_6526_cia_recreated/mos_6526_cia_recreated.pdf), sheet 7,
//     "Interrupt Control": "Any interrupt will set the corresponding bit in
//     the DATA register. Any interrupt which is enabled by the MASK register
//     will set the IR bit (MSB) of the DATA register and bring the /IRQ pin
//     low. ... the interrupt DATA register is cleared and the /IRQ line
//     returns high following a read of the DATA register." → the IR bit /
//     /IRQ is a phi2-clocked flip-flop one clock behind the masked-data
//     condition.
//   - VICE testprogs interrupts/irq-ackn-bug (cia.txt + cia1.prg/cia2.prg,
//     NEWCIA=0 reference): a $DC0D read coincident with the underflow returns
//     the data bit WITHOUT bit 7 ($01) — the IR has not latched yet. The
//     reference TimerB ($da, not the handler-delayed value) shows the IRQ is
//     not delivered in the measurement window: the racing read confuses the
//     value it returns but the interrupt is swallowed (old-6526 behavior).
//
// These are synthetic, derived from those rules — not from observing the impl.

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

function makeCia() {
  const cia = new CIA(1);
  cia.irqHandler = () => {};
  return cia;
}

// Drive a started Timer A to its underflow cycle and return the CIA parked so
// the NEXT clock() is the underflow (timerA === 0, about to reload).
function armToUnderflowEdge(cia, latch) {
  cia.write(0x04, latch & 0xFF); cia.write(0x05, (latch >> 8) & 0xFF);
  cia.write(0x0D, 0x81);                 // enable TA interrupt
  cia.write(0x0E, 0x11);                 // force-load + start (2-clock load phase)
  cia.clock(1); cia.clock(1);            // load phase
  while (cia.timerA !== 0) cia.clock(1); // count down to 0
}

// ── 1: data bit is immediate; IR bit / /IRQ follows one clock later ──────
{
  const cia = makeCia();
  armToUnderflowEdge(cia, 4);
  expect((cia.icrStatus & 0x01) === 0, `pre-underflow: TA data bit clear`);
  expect(cia.irqState === false, `pre-underflow: /IRQ low`);
  cia.clock(1);                          // underflow cycle
  expect((cia.icrStatus & 0x01) === 0x01,
    `underflow: TA data bit set immediately (datasheet: "sets the corresponding bit in the DATA register")`);
  expect(cia.irqState === false,
    `underflow: IR bit / /IRQ NOT yet set (the IR latch is one phi2 behind)`);
  cia.clock(1);                          // IR latch clock
  expect(cia.irqState === true,
    `+1 clock: IR latch sets /IRQ (datasheet: enabled interrupt "will set the IR bit ... and bring /IRQ low")`);
  ok('MOS6526: ICR data bit immediate, IR bit / /IRQ follows one clock (datasheet sheet 7)');
}

// ── 2: $DC0D read at the IR-latch cycle returns $81 and acknowledges ──────
// A read once the IR has latched is a clean acknowledge: returns bit 7 + the
// data bit, clears both, /IRQ returns high, no further IRQ.
{
  const cia = makeCia();
  armToUnderflowEdge(cia, 4);
  cia.clock(1);                          // underflow: data bit set
  cia.clock(1);                          // IR latch set
  expect(cia.irqState === true, `precondition: /IRQ asserted`);
  const v = cia.read(0x0D);
  expect((v & 0x81) === 0x81, `clean read returns IR (bit 7) + TA data bit, got $${v.toString(16)}`);
  expect(cia.icrStatus === 0, `read clears the DATA register`);
  cia.clock(1);
  expect(cia.irqState === false,
    `clean acknowledge: /IRQ stays high after the read (no resurrected IRQ)`);
  ok('MOS6526: $DC0D read after IR latched = clean acknowledge ($81, /IRQ clears)');
}

// ── 3: the ack bug — read on the underflow cycle returns $01 ─────────────
// When the $DC0D read coincides with the underflow (data bit just set, IR not
// yet latched), the read returns the data bit WITHOUT bit 7 ($01) — the
// hallmark of the ack bug, distinct from both a clean $81 (IR settled) and a
// clean $00 (nothing). The racing read empties the DATA register one cycle
// too early to ever surface the IR bit, so /IRQ is not delivered: irqState
// stays low across the following clocks (matches the reference TimerB=$da,
// i.e. no handler ran in the measurement window).
{
  const cia = makeCia();
  armToUnderflowEdge(cia, 4);
  cia.clock(1);                          // underflow cycle: data bit set, IR armed, not latched
  expect((cia.icrStatus & 0x01) === 0x01 && cia.irqState === false,
    `race precondition: data bit set, IR not yet latched`);
  const v = cia.read(0x0D);              // read coincident with the underflow
  expect((v & 0x80) === 0,
    `ack bug: read returns NO IR bit (bit 7 clear), got $${v.toString(16)}`);
  expect((v & 0x01) === 0x01,
    `ack bug: read returns the TA data bit ($01), got $${v.toString(16)}`);
  // The racing read swallowed the interrupt — /IRQ is not delivered.
  cia.clock(1);
  expect(cia.irqState === false,
    `ack bug: no IRQ delivered after the racing read (the read was one cycle too early)`);
  cia.clock(1);
  expect(cia.irqState === false,
    `ack bug: still no IRQ a further clock later (interrupt swallowed)`);
  ok('MOS6526: $DC0D read racing the underflow reads $01 and the interrupt is swallowed (ack bug)');
}

// ── 4: a read one clock BEFORE the underflow does NOT see or arm anything ──
{
  const cia = makeCia();
  armToUnderflowEdge(cia, 4);            // parked at timerA === 0, underflow is NEXT clock
  const v = cia.read(0x0D);              // read before the underflow processes
  expect((v & 0x81) === 0,
    `pre-underflow read: nothing latched yet ($00), got $${v.toString(16)}`);
  ok('MOS6526: $DC0D read before the underflow cycle reads $00');
}

console.log(`\n${testNo} CIA interrupt-acknowledge-bug spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
