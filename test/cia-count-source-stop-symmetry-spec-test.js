// MOS 6526 CIA — count-source selection and control-write symmetry.
//
// Locks five behaviors that were previously missing or asymmetric (a friend's
// code review surfaced them). Each is derived from the datasheet's control-
// register semantics, mirroring the existing Timer-B count-mode + Timer-A
// stop-delay tests:
//
//   #3 Timer A CNT input mode (CRA bit 5): like Timer B, Timer A can count CNT
//      positive edges instead of PHI2. Was hard-wired to PHI2.
//   #4 CNT edge detection is per-clock, not a sticky latch: an edge that
//      arrives while both timers are stopped must not be retained and consumed
//      by a later CNT-mode start.
//   #5 Timer B stop delay symmetric to Timer A: a CRB write clearing START
//      does ONE more count before freezing (the 6526 one-cycle control-write
//      delay; the CIA is clocked at phi1, before the CPU's phi2 write).
//   #6 A LOAD+START load-phase countdown is cancelled if START is cleared
//      before it elapses, so it cannot delay a later plain START.
//   #7 clock(cycles>1) returns whether ANY Timer A underflow occurred in the
//      span (it used to always return false).
//
// Spec source: MOS 6526 datasheet (https://dn710607.ca.archive.org/0/items/mos_6526_cia_recreated/mos_6526_cia_recreated.pdf), CRA/CRB
// register definitions (INMODE bits) + the count/underflow description.
// Synthetic, derived from those rules — not from observing the impl.

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
function makeCia() { const c = new CIA(1); c.irqHandler = () => {}; return c; }

// ── #3a: Timer A CNT mode does NOT count without CNT edges ───────────────
{
  const cia = makeCia();
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);   // latch A = 2
  cia.write(0x0D, 0x81);                            // enable TA interrupt
  cia.write(0x0E, 0b00110001);                      // CRA: CNT mode (b5) + force-load (b4) + start (b0)
  for (let c = 0; c < 100; c++) cia.clock(1);       // many PHI2 cycles, no CNT edges
  expect(cia.timerA === 2, `TA CNT mode without CNT pulses: must NOT count, timerA stays 2 (got ${cia.timerA})`);
  expect((cia.icrStatus & 0x01) === 0, `TA CNT mode without CNT pulses: no underflow IRQ`);
  ok('MOS6526: Timer A CNT mode (CRA bit 5) requires CNT positive edges (ignores PHI2)');
}

// ── #3b: Timer A CNT mode counts CNT rising edges, ignores PHI2 ───────────
{
  const cia = makeCia();
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);   // latch A = 2
  cia.write(0x0D, 0x81);
  cia.write(0x0E, 0b00110001);                      // CNT mode + force-load + start → timerA = 2
  cia.clock(1); cia.clock(1);                       // 2-clock load phase (no edges)
  cia._cntRising = true; cia.clock(1);              // edge 1: 2 → 1
  expect(cia.timerA === 1, `TA CNT edge 1: 2→1, got ${cia.timerA}`);
  cia.clock(1);                                      // PHI2 with no edge: must NOT count
  expect(cia.timerA === 1, `TA CNT mode ignores a PHI2 cycle with no edge (got ${cia.timerA})`);
  cia._cntRising = true; cia.clock(1);              // edge 2: 1 → 0
  cia._cntRising = true; cia.clock(1);              // edge 3: 0 → reload + IRQ
  expect((cia.icrStatus & 0x01) === 0x01, `TA CNT underflow on the 3rd edge sets ICR bit 0`);
  expect(cia.timerA === 2, `TA reloads to latch (2) on underflow, got ${cia.timerA}`);
  ok('MOS6526: Timer A CNT mode counts CNT rising edges (PHI2 cycles do not count)');
}

// ── #4: a CNT edge while stopped is NOT retained for a later start ────────
{
  const cia = makeCia();
  cia.setCnt(0); cia.setCnt(1);                     // rising edge while both timers stopped
  expect(cia._cntRising === true, `precondition: setCnt 0→1 armed a rising edge`);
  cia.clock(1);                                      // one clock with both timers stopped
  expect(cia._cntRising === false,
    `CNT edge must be consumed/cleared every clock, not held while stopped`);
  // Behavioral consequence: arming TB in CNT mode afterwards must not count a
  // phantom pre-start edge.
  cia.write(0x06, 0x02); cia.write(0x07, 0x00);   // TB latch = 2
  cia.write(0x0F, 0b00110001);                      // TB CNT mode + force-load + start → timerB = 2
  cia.clock(1); cia.clock(1);                       // 2-clock load phase (no edge)
  const before = cia.timerB;
  cia.clock(1);                                      // PHI2 with no edge
  expect(cia.timerB === before, `TB CNT mode does not count a stale pre-start edge (got ${before}→${cia.timerB})`);
  ok('MOS6526: CNT rising edge is per-clock, not a sticky latch across stopped timers');
}

// ── #5: Timer B stop is delayed one count, symmetric to Timer A ──────────
{
  const cia = makeCia();
  cia.write(0x06, 0x40); cia.write(0x07, 0x00);   // latch B = 0x40
  cia.write(0x0F, 0x11);                            // CRB: force-load + start, count mode 00 (PHI2)
  for (let c = 0; c < 6; c++) cia.clock(1);         // load phase + a few counts
  const stopVal = cia.timerB;
  cia.write(0x0F, 0x00);                            // STOP (no force-load)
  cia.clock(1);
  const afterStop = cia.timerB;
  expect(afterStop === ((stopVal - 1) & 0xFFFF),
    `TB does ONE more count after a CRB stop (1-cycle delay): ${stopVal}→${afterStop}`);
  cia.clock(1);
  expect(cia.timerB === afterStop, `then frozen — no further count, got ${afterStop}→${cia.timerB}`);
  ok('MOS6526: $DC0F bit 0 = 0 stops Timer B with a 1-cycle delay (symmetric to Timer A)');
}

// ── #6: a stale LOAD+START load phase is cancelled by an intervening stop ──
// LOAD+START arms a 2-clock load phase. Clearing START before it elapses must
// cancel it. A later plain START carries its own ONE-clock count-hold
// (VICE-measured, cia-start oracle) — a stale 2-clock load phase would hold
// one clock longer, so the second clock still discriminates the cancel.
{
  const cia = makeCia();
  cia.write(0x04, 0x10); cia.write(0x05, 0x00);   // latch A = 16
  cia.write(0x0E, 0x11);                            // LOAD+START → timerA = 16, arms 2-clock load phase
  cia.write(0x0E, 0x00);                            // STOP immediately (cancels the load phase; arms 1-count stop delay)
  cia.clock(1);                                      // stop-delay final count: 16 → 15
  cia.clock(1);                                      // frozen at 15
  expect(cia.timerA === 15, `after stop: one final count then frozen at 15, got ${cia.timerA}`);
  cia.write(0x0E, 0x01);                            // plain START (no load)
  cia.clock(1);                                      // start count-hold: stays 15
  expect(cia.timerA === 15,
    `plain START holds one clock: got ${cia.timerA} expected 15 (a reload would show 16)`);
  cia.clock(1);                                      // first count
  expect(cia.timerA === 14,
    `plain START counts on the 2nd clock: 15→14, got ${cia.timerA} (a stale 2-clock load phase would leave 15)`);
  ok('MOS6526: an intervening STOP cancels a pending LOAD+START load phase');
}

// ── #7: clock(cycles>1) reports whether any Timer A underflow occurred ────
{
  const cia = makeCia();
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);   // latch A = 2 → underflows within a 10-clock span
  cia.write(0x0E, 0x11);                            // LOAD+START
  expect(cia.clock(10) === true, `clock(10) returns true when a TA underflow occurred in the span`);

  const cia2 = makeCia();
  cia2.write(0x04, 0xFF); cia2.write(0x05, 0xFF); // latch A large → no underflow in 5 clocks
  cia2.write(0x0E, 0x11);
  expect(cia2.clock(5) === false, `clock(5) returns false when no underflow occurred`);
  ok('MOS6526: clock(cycles>1) returns the OR of Timer A underflows over the span');
}

// ── #8: a stop-write that ALSO flips the count-source mode — the delayed
// final count runs under the mode the timer was RUNNING in, not the just-
// written mode. Timer A in PHI2; one write clears START and sets CNT (bit 5).
// The final count must still happen (old PHI2 mode), not be skipped as it would
// under the new CNT mode (no CNT edge). Pins _craStopControl.
{
  const cia = makeCia();
  cia.write(0x04, 0x10); cia.write(0x05, 0x00);   // latch A = 16
  cia.write(0x0E, 0x11);                            // PHI2 continuous + force-load + start
  cia.clock(1); cia.clock(1);                       // 2-clock load phase
  cia.clock(1); cia.clock(1);                       // count twice (PHI2): 16→14
  const before = cia.timerA;
  cia.write(0x0E, 0x20);                            // STOP (bit0=0) + switch to CNT mode (bit5), no load
  cia.clock(1);                                     // delayed final count: old PHI2 mode → counts once
  expect(cia.timerA === ((before - 1) & 0xFFFF),
    `stop+mode-flip: final count uses the OLD PHI2 mode (counts once), got ${before}→${cia.timerA} ` +
    `(under the new CNT mode it would wrongly freeze at ${before})`);
  cia.clock(1);                                     // now frozen
  expect(cia.timerA === ((before - 1) & 0xFFFF), `then frozen, got ${cia.timerA}`);
  ok('MOS6526: delayed stop count uses the running mode, not a same-write mode change (Timer A)');
}

console.log(`\n${testNo} CIA count-source / stop-symmetry spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
