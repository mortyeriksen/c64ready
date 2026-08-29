// MOS 6526 CIA — the IR flip-flop (/IRQ, ICR bit 7) is a STICKY, set-dominant
// latch, NOT a level copy of the (DATA & MASK) condition.
//
// Spec source:
//   - MOS 6526 datasheet (https://dn710607.ca.archive.org/0/items/mos_6526_cia_recreated/mos_6526_cia_recreated.pdf), sheet 7,
//     "Interrupt Control": "Any interrupt will set the corresponding bit in the
//     DATA register. Any interrupt which is ENABLED by the MASK register will
//     set the IR bit (MSB) and bring the /IRQ pin low. ... the interrupt DATA
//     register is cleared and the /IRQ line returns high following a READ of the
//     DATA register."  → the IR bit / /IRQ is cleared ONLY by an ICR read.
//   - Lorenz / VICE (NEWCIA=0): SETTING a mask bit while its DATA bit is already
//     pending fires the interrupt; CLEARING a mask bit must NOT clear an
//     already-latched IRQ — masking gates future latching, it does not ack.
//
// These are synthetic, derived from those rules — not from observing the impl.
// Companion: cia-irq-ackn-bug-spec-test.js (the ICR-read-races-the-arm swallow,
// which this set-dominant model must NOT regress — guarded in test 6).

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

// CIA whose /IRQ transitions we record (the public output, not the internal
// latch). irqHandler(state) fires on every change of irqState (=_irLatch).
function makeCia() {
  const cia = new CIA(1);
  cia.irqEvents = [];
  cia.irqHandler = (state) => cia.irqEvents.push(state);
  return cia;
}

// Fire ONE Timer A underflow with interrupts MASKED OFF: the underflow sets ICR
// DATA bit 0 but raises no /IRQ. One-shot so the timer stops after — icrStatus
// bit 0 is set exactly once (no re-raise to confuse the mask tests below).
function fireMaskedTimerAUnderflow(cia) {
  cia.icrMask = 0;                       // ensure all sources masked off
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);  // latch A = 2
  cia.write(0x0E, 0x19);                 // force-load(0x10) + start(0x01) + one-shot(0x08)
  for (let i = 0; i < 12 && !(cia.icrStatus & 0x01); i++) cia.clock(1);
}

// ── 1: a masked source sets the DATA bit but does NOT latch IR / pull /IRQ ──
{
  const cia = makeCia();
  fireMaskedTimerAUnderflow(cia);
  cia.clock(1); cia.clock(1);            // give the latch every chance to (wrongly) arm
  expect((cia.peek(0x0D) & 0x01) === 1, `masked underflow sets ICR DATA bit 0`);
  expect((cia.peek(0x0D) & 0x80) === 0, `IR bit (7) NOT set while masked`);
  expect(cia.irqState === false, `/IRQ stays HIGH while the source is masked`);
  ok('masked source sets DATA but does not latch IR (/IRQ stays high)');
}

// ── 2: ENABLING the mask over a pending DATA bit latches IR / pulls /IRQ ─────
{
  const cia = makeCia();
  fireMaskedTimerAUnderflow(cia);
  expect(cia.irqState === false, `precondition: /IRQ high (still masked)`);
  cia.write(0x0D, 0x81);                 // enable Timer A interrupt (bit7=set, bit0)
  expect(cia.irqState === false, `mask-enable alone does not assert (IR lags one clock)`);
  cia.clock(1);                          // IR matures one clock later
  expect(cia.irqState === true, `enabling the mask over a pending DATA bit asserts /IRQ`);
  expect((cia.peek(0x0D) & 0x80) === 0x80, `IR bit (7) now set`);
  ok('enabling the mask over an already-pending DATA bit latches IR (/IRQ low)');
}

// ── 3: CLEARING the mask must NOT clear an already-latched IRQ (STICKY) ──────
{
  const cia = makeCia();
  fireMaskedTimerAUnderflow(cia);
  cia.write(0x0D, 0x81); cia.clock(1);   // latch IR / assert /IRQ
  expect(cia.irqState === true, `precondition: /IRQ asserted`);
  const eventsBefore = cia.irqEvents.length;

  cia.write(0x0D, 0x01);                 // CLEAR mask bit 0 (bit7=0 → clear), no read
  expect((cia.icrMask & 0x01) === 0, `mask bit 0 cleared`);
  expect(cia.irqState === true, `/IRQ still asserted immediately after mask-clear`);
  cia.clock(1); cia.clock(1);            // clock past where a level-copy would drop it
  expect(cia.irqState === true,
    `STICKY: /IRQ remains asserted after a mask-clear (until an ICR read)`);
  expect(cia.irqEvents.length === eventsBefore,
    `no /IRQ transition emitted by the mask-clear (it neither asserts nor acks)`);
  ok('mask-clear does NOT clear an already-latched IRQ (sticky flip-flop)');
}

// ── 4: only an ICR READ acknowledges — clears IR + DATA, /IRQ returns high ──
{
  const cia = makeCia();
  fireMaskedTimerAUnderflow(cia);
  cia.write(0x0D, 0x81); cia.clock(1);
  cia.write(0x0D, 0x01);                 // clear mask (sticky → /IRQ stays)
  cia.clock(1);
  expect(cia.irqState === true, `precondition: /IRQ asserted, mask cleared`);

  const v = cia.read(0x0D);              // the legitimate acknowledge
  expect((v & 0x80) === 0x80, `ICR read returns IR bit set ($80); got $${v.toString(16)}`);
  expect((v & 0x01) === 0x01, `ICR read returns the Timer A DATA bit ($01)`);
  expect(cia.irqState === false, `/IRQ returns HIGH after the ICR read`);
  expect((cia.peek(0x0D) & 0x1F) === 0, `DATA bits cleared by the read`);
  cia.clock(1); cia.clock(1);
  expect(cia.irqState === false, `/IRQ stays high (no spurious re-assert after ack)`);
  ok('ICR read is the sole acknowledge — clears IR + DATA, /IRQ returns high');
}

// ── 5: full normal cycle (mask enabled BEFORE the underflow) is unchanged ───
{
  const cia = makeCia();
  cia.write(0x0D, 0x81);                 // enable Timer A IRQ up front
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x19);                 // force-load + start + one-shot
  let asserted = false;
  for (let i = 0; i < 12 && !asserted; i++) { cia.clock(1); asserted = cia.irqState; }
  expect(asserted === true, `Timer A underflow with mask enabled asserts /IRQ`);
  const v = cia.read(0x0D);
  expect((v & 0x81) === 0x81, `read returns IR + Timer A DATA ($81); got $${v.toString(16)}`);
  expect(cia.irqState === false, `/IRQ clears after the read`);
  ok('normal underflow→IRQ→ICR-read cycle is unaffected by the sticky model');
}

// ── 6: REGRESSION GUARD — the old-6526 ICR-read-races-the-arm swallow still
//      works (the sticky change must not turn a swallowed race into a latch). ─
{
  const cia = makeCia();
  cia.icrMask = 0x01;
  cia._raiseIcr(0x01);                   // DATA bit set this cycle; IR not yet latched
  cia.write(0x0D, 0x81);                 // (re)affirm mask + recompute arm
  // Precondition via the OBSERVABLE IR bit (peek $0D bit 7), not the private
  // _irLatch field: at the racing read the IR has not matured yet, so bit 7 reads 0.
  expect((cia.peek(0x0D) & 0x80) === 0, `precondition: IR bit not yet latched at the racing read`);
  const v = cia.read(0x0D);              // read RACES the arm
  cia.clock(1); cia.clock(1);            // clock through the race window
  expect((v & 0x80) === 0, `racing read returns DATA without bit 7 ($01); got $${v.toString(16)}`);
  expect(cia.irqState === false, `old-6526: the raced interrupt is SWALLOWED (/IRQ never asserts)`);
  ok('ack-bug race-swallow preserved: a read racing the arm is not turned into a sticky latch');
}

console.log(`\n${testNo} IR-latch sticky spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
