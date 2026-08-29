// MOS 6526 CIA — Timer-B cascade (count Timer-A underflows) timing + the
// mode-dependent underflow read aperture. (#15)
//
// Spec source: a deterministic VICE cascade oracle with NEWCIA=0, randomized
// autostart delay disabled, and DEN off. Two facts it pinned, both now
// byte-identical to VICE (0/252) across TB latches 0..20 × 12 reads:
//
//  (a) The LOAD+START load phase blocks only the PHI2-clocked count. An
//      externally-clocked timer (CNT edge, or Timer-A-underflow cascade) counts
//      from the FIRST clock — VICE counts the TA underflow that lands in the
//      load-phase window, so a cascade timer is NOT delayed by 2 clocks.
//  (b) The #14 underflow read substitution (running timer at 0 reads the
//      reloaded latch) applies ONLY in PHI2 mode. In CNT/cascade modes the count
//      input is sparse, so the 0 PERSISTS until the next count event and a read
//      returns 0 (VICE reads 0 there, not the latch).
//
// Friend's #15: "TB's count input should be driven by TA's underflow through the
// counting pipeline, not an immediate same-branch boolean." Confirmed + fixed.

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
const makeCia = () => { const c = new CIA(1); c.irqHandler = () => {}; return c; };

// ── 1: TB in CASCADE mode (10) at underflow reads 0, NOT the latch ───────────
{
  const c = makeCia();
  c.latchB = 0x0042; c.timerB = 0x0000;
  c.crb = 0x41;               // running (bit0) + INMODE 10 (bit6) = count TA underflow
  expect(c.read(0x06) === 0x00 && c.read(0x07) === 0x00,
    `cascade TB at 0 reads 0 (not latch $42), got $${c.read(0x07).toString(16)}${c.read(0x06).toString(16)}`);
  ok('cascade-mode (10) Timer B at underflow reads 0, not the reloaded latch');
}

// ── 2: TB in PHI2 mode (00) at underflow reads the latch (the #14 substitution
//      still applies in PHI2 mode) — contrast with test 1. ───────────────────
{
  const c = makeCia();
  c.latchB = 0x0042; c.timerB = 0x0000;
  c.crb = 0x01;               // running + INMODE 00 (PHI2)
  expect(c.read(0x06) === 0x42, `PHI2 TB at underflow reads latch $42, got $${c.read(0x06).toString(16)}`);
  ok('PHI2-mode Timer B at underflow still reads the reloaded latch (#14)');
}

// ── 3: TA in CNT mode at underflow reads 0 (substitution is PHI2-only) ────────
{
  const c = makeCia();
  c.latchA = 0x0055; c.timerA = 0x0000;
  c.cra = 0x21;               // running + INMODE CNT (bit5)
  expect(c.read(0x04) === 0x00, `CNT-mode TA at 0 reads 0 (not latch $55), got $${c.read(0x04).toString(16)}`);
  c.cra = 0x01;               // PHI2 mode → substitutes
  expect(c.read(0x04) === 0x55, `PHI2-mode TA at 0 reads latch $55, got $${c.read(0x04).toString(16)}`);
  ok('underflow read substitution is PHI2-only (CNT mode reads 0)');
}

// ── 4: cascade counts from the FIRST clock — the load phase does NOT block an
//      external count. With Timer A PRE-WARMED (past its own load phase) and
//      underflowing every 2 clocks, a cascade TB started via LOAD+START counts
//      the next TA underflow even though TB is still in its own load-phase
//      window. (Full per-clock sequence is locked by the cascade oracle, 0/252.)
{
  const c = makeCia();
  c.write(0x04, 0x01); c.write(0x05, 0x00);   // TA latch 1 → underflow every 2 clocks
  c.write(0x0E, 0x11);                          // TA force-load + START (continuous)
  for (let i = 0; i < 6; i++) c.clock(1);       // pre-warm: TA past its load phase, free-running
  c.write(0x06, 0x08); c.write(0x07, 0x00);   // TB latch = 8
  c.write(0x0F, 0x51);                          // TB force-load + START + INMODE 10
  // Over the next 8 clocks TA underflows ~4 times; a cascade TB that the load
  // phase did NOT block decrements ~4 times (would be ~3 if the first cascade
  // count were swallowed by the 2-clock load-phase block).
  let counts = 0, prev = c.timerB;
  for (let i = 0; i < 8; i++) { c.clock(1); if (c.timerB !== prev) counts++; prev = c.timerB; }
  expect(counts >= 4,
    `cascade TB counted the TA underflows that fell in its load-phase window (${counts} decrements in 8 clocks, expect >=4)`);
  ok('cascade count is not blocked by the LOAD+START load phase');
}

console.log(`\n${testNo} Timer-B cascade spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
