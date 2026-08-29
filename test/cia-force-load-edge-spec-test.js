// MOS 6526 CIA force-load edge cases — extends cia-timer-spec-test.js
// with scenarios that determine whether the load phase fires.
//
// Spec source: MOS 6526 datasheet (https://dn710607.ca.archive.org/0/items/mos_6526_cia_recreated/mos_6526_cia_recreated.pdf)
// "Force Load: A strobe bit allows the timer latch to be loaded into
//  the timer counter at any time, whether the timer is running or not."
//
// SPEC DEVIATION (test-side, intentional):
//   Real-silicon characterization via VICE testprogs/VICII/sb_sprite_fetch
//   (the canonical stable-IRQ chain): a CRA write that sets BOTH bit 4
//   (LOAD) AND bit 0 (START) results in a 2-cycle internal load phase in the
//   raw cia.clock() primitive (cia.js _craStartPending = 2). The machine now
//   clocks the CIA at phi1 (before the CPU's phi2 write), so a force-load
//   write is first seen by the NEXT cycle's clock — that extra cycle + this
//   2-clock phase reproduce the 3-clock NET load phase the old CIA-after-CPU
//   ordering needed, so sb_sprite_fetch's open-side-border chain still lands
//   `sty $d016` at the spec-required cycle. These unit tests drive cia.clock()
//   directly (no machine phi1 ordering), so they pin the raw 2-clock phase.
//   Plain start (bit 0 0→1, no LOAD) still has NO chip-internal delay.
//
// This file pins the rules our impl applies so a future re-tuning of
// the CIA timer pipeline catches each branch:
//   • Force-load + start (bit 4=1, new bit 0=1, prior bit 0=0)
//   • Force-load on already-running timer (bit 4=1, prior bit 0=1)
//   • Force-load + stop (bit 4=1, new bit 0=0)
//   • Plain start without force-load (bit 4=0, bit 0 0→1)
//   • Continuous start (bit 4=0, bit 0 was 1, stays 1)
//   • Stop then restart without LOAD (start latency = 0 chip-internal)

import { CIA } from '../src/cia.js';

function makeCia() {
  const cia = new CIA();
  cia.id = 1;
  cia.irqHandler = () => {};
  return cia;
}

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

// ── 1: Force-load + start from stopped: 3-cycle chip-internal delay ──
// CRA was 0; write $11 (LOAD + START). Expect 3-clock load phase, then
// counting begins. (Test-side spec deviation: see file header.)
{
  const cia = makeCia();
  cia.write(0x04, 10); cia.write(0x05, 0);            // latch=10
  cia.write(0x0E, 0x11);                               // LOAD + START
  expect(cia.timerA === 10, `force-load: timer=10, got ${cia.timerA}`);
  cia.clock(1); cia.clock(1);                          // 2-clock load phase
  expect(cia.timerA === 10, `still in load phase: timer=10, got ${cia.timerA}`);
  cia.clock(1);
  expect(cia.timerA === 9, `1 clock after load phase: timer=9, got ${cia.timerA}`);
  ok('MOS6526: force-load+start from stopped → 2-clock load phase, then count');
}

// ── 2: Force-load on already-running timer: 3-cycle delay ─────────────
// CRA bit 0 was 1 (running); write a CRA that keeps bit 0 set AND sets
// bit 4. The LOAD strobe re-seeds the counter and resets the internal
// phase machine through the same 3-clock load phase as case 1.
// (Test-side spec deviation: see file header.)
{
  const cia = makeCia();
  cia.write(0x04, 100); cia.write(0x05, 0);
  cia.write(0x0E, 0x01);                               // start (no LOAD)
  cia.clock(1); cia.clock(1); cia.clock(1);            // count down
  const beforeReload = cia.timerA;
  expect(beforeReload < 100, `pre-reload: timer must have decremented from 100, got ${beforeReload}`);
  // Now change latch and force-load while still running.
  cia.write(0x04, 10);                                  // new latch=10
  cia.write(0x0E, 0x11);                               // LOAD + START (still)
  expect(cia.timerA === 10, `force-load while running: timer=10`);
  cia.clock(1); cia.clock(1);                          // 2-clock load phase
  expect(cia.timerA === 10,
    `force-load on running timer: still in load phase after 2 clocks, got ${cia.timerA}`);
  cia.clock(1);
  expect(cia.timerA === 9,
    `force-load on running timer: counting resumes after load phase, got ${cia.timerA}`);
  ok('MOS6526: force-load on already-running timer → 2-clock load phase');
}

// ── 3: Force-load + STOP: timer reloaded but no pending (counting halted) ──
// bit 4=1 (LOAD), bit 0=0 (STOP). Timer reloads from latch but doesn't
// count. No load phase counter needed since not counting.
{
  const cia = makeCia();
  cia.write(0x04, 50); cia.write(0x05, 0);
  cia.write(0x0E, 0x10);                               // LOAD only
  expect(cia.timerA === 50, `force-load: timer=50`);
  cia.clock(1); cia.clock(1); cia.clock(1);            // many clocks
  expect(cia.timerA === 50,
    `force-load + stop: timer must NOT count, got ${cia.timerA}`);
  ok('MOS6526: force-load + stop → reload, no counting');
}

// ── 4: Plain start (no LOAD) from stopped: ONE-clock count-hold ────
// VICE-measured (cia-start oracle): a plain START 0→1 without force-load
// holds the count for one clock before the first decrement, on TA and TB
// alike. No RELOAD is involved (the counter keeps its current value —
// "no load phase" remains true); only the first count is one clock later
// than an immediate-count model.
{
  const cia = makeCia();
  cia.timerA = 100;                                    // pre-set
  cia.latchA = 100;
  cia.write(0x0E, 0x01);                               // pure START (no LOAD)
  cia.clock(1);
  expect(cia.timerA === 100, `plain start: 1st clock holds (count-hold), got ${cia.timerA}`);
  cia.clock(1);
  expect(cia.timerA === 99, `plain start: 2nd clock does the first count, got ${cia.timerA}`);
  cia.clock(1);
  expect(cia.timerA === 98, `plain start: 3rd clock counts again, got ${cia.timerA}`);
  ok('MOS6526: plain start (no LOAD) → one-clock count-hold, no reload');
}

// ── 5: Continuous start (bit 0 already 1, write keeps it): no re-trigger ──
// CRA written with bit 0 unchanged (was 1, stays 1) and bit 4=0. No
// state transition on start, no LOAD. Counting must continue
// uninterrupted.
{
  const cia = makeCia();
  cia.write(0x04, 100); cia.write(0x05, 0);
  cia.write(0x0E, 0x01);                               // start
  cia.clock(1); cia.clock(1);                          // count
  const before = cia.timerA;
  cia.write(0x0E, 0x01);                               // re-write same CRA
  cia.clock(1);
  expect(cia.timerA === before - 1,
    `continuous start: no pending re-trigger, just continues counting (before=${before}, after=${cia.timerA})`);
  ok('MOS6526: same-value CRA write does not re-trigger load phase');
}

// ── 6: Stop then re-start without LOAD: still no chip-internal delay ──
// Timer running → stop (bit 0 1→0) → start (bit 0 0→1, no LOAD). Per
// datasheet, plain start has no load phase regardless of prior state. NOTE:
// the STOP has a one-cycle delay (one final count) — real-hardware-verified by
// testprogs/VICII/split-tests/bascan — so the timer counts once more after the
// stop write before freezing.
{
  const cia = makeCia();
  cia.write(0x04, 100); cia.write(0x05, 0);
  cia.write(0x0E, 0x01);                               // start
  cia.clock(1); cia.clock(1); cia.clock(1);
  const beforeStop = cia.timerA;
  cia.write(0x0E, 0x00);                               // stop (1-cycle delay)
  cia.clock(1);                                        // the delayed final count
  const afterStop = cia.timerA;
  expect(afterStop === beforeStop - 1, `stop 1-cycle delay: ${beforeStop}→${afterStop}`);
  cia.clock(1);                                        // now halted; unchanged
  expect(cia.timerA === afterStop, `stopped: timer unchanged after the delay`);
  cia.write(0x0E, 0x01);                               // re-start (no LOAD)
  cia.clock(1);
  expect(cia.timerA === afterStop,
    `re-start: 1st clock holds (one-clock start count-hold), got ${cia.timerA} expected ${afterStop}`);
  cia.clock(1);
  expect(cia.timerA === afterStop - 1,
    `re-start: 2nd clock resumes counting from the held value (no reload), got ${cia.timerA} expected ${afterStop - 1}`);
  ok('MOS6526: stop→start resumes with the one-clock count-hold, no reload');
}

// ── 7: TimerB symmetric: force-load+start has same 3-clock load phase ──
// CRB has the same LOAD/START semantics as CRA per datasheet. Confirm.
// (Test-side spec deviation: see file header.)
{
  const cia = makeCia();
  cia.write(0x06, 10); cia.write(0x07, 0);             // latchB=10
  cia.write(0x0F, 0x11);                               // LOAD + START
  expect(cia.timerB === 10, `force-load B: timer=10`);
  cia.clock(1); cia.clock(1);
  expect(cia.timerB === 10, `B in load phase`);
  cia.clock(1);
  expect(cia.timerB === 9,
    `B counts after load phase, got ${cia.timerB}`);
  ok('MOS6526: timerB force-load+start → 2-clock load phase (symmetric to A)');
}

// ── 8: LOAD strobe auto-clears (CRA bit 4 readback is 0) ─────────────
// Bit 4 is a STROBE, not stored. Reading CRA must always return bit 4=0.
{
  const cia = makeCia();
  cia.write(0x0E, 0x11);                               // LOAD + START
  expect((cia.cra & 0x10) === 0,
    `CRA bit 4 must auto-clear, got cra=$${cia.cra.toString(16)}`);
  expect(cia.cra & 0x01,
    `CRA bit 0 (start) must persist, got cra=$${cia.cra.toString(16)}`);
  ok('MOS6526: LOAD bit (CRA bit 4) is strobe — auto-clears, START bit persists');
}

// ── 9: Force-load DURING load phase resets the load phase counter ────
// CPU writes LOAD+START twice in quick succession. Each LOAD strobe
// re-arms the load phase. After the second write, 2 more clocks of
// load phase are required before counting resumes.
// (Test-side spec deviation: see file header.)
{
  const cia = makeCia();
  cia.write(0x04, 10); cia.write(0x05, 0);
  cia.write(0x0E, 0x11);                               // LOAD + START
  cia.clock(1);                                         // 1 of 2 load phase
  cia.write(0x0E, 0x11);                               // re-LOAD + START
  cia.clock(1); cia.clock(1);                          // need 2 fresh load clocks
  expect(cia.timerA === 10,
    `re-LOAD restarts load phase: still 10 after 2 clocks, got ${cia.timerA}`);
  cia.clock(1);
  expect(cia.timerA === 9, `counting resumes, got ${cia.timerA}`);
  ok('MOS6526: re-LOAD during load phase restarts the 2-clock load phase');
}

// ── 10: Underflow + reload — first underflow takes load_phase + N + 1 ──
// Force-load+start with latch=N. Total clocks to first underflow is
// 3 (load) + N (count down) + 1 (the cycle where 0→underflow). After
// underflow, the timer reloads from latch but the post-underflow
// reload does NOT add another load phase (only force-load via bit 4
// does). (Test-side spec deviation: see file header.)
{
  const cia = makeCia();
  cia.write(0x04, 3); cia.write(0x05, 0);              // latch=3
  cia.write(0x0E, 0x11);                               // LOAD + START
  // Total = 2 (load) + 3 (count 3→2→1→0) + 1 (underflow→reload) = 6 clocks
  for (let i = 0; i < 6; i++) cia.clock(1);
  // Underflow has fired and timer reloaded to 3 on the 5th clock. The ICR DATA
  // bit (bit 0) latches on the underflow cycle (the IR/bit 7 + /IRQ follow one
  // clock later via the IR latch — datasheet sheet 7).
  expect((cia.icrStatus & 0x01) === 0x01,
    `underflow IRQ must fire after load+count+reload sequence`);
  expect(cia.timerA === 3,
    `post-underflow timer must equal latch (3), got ${cia.timerA}`);
  // The NEXT cycle continues counting WITHOUT a fresh load phase
  // (only a fresh LOAD strobe restarts the phase machine).
  cia.clock(1);
  expect(cia.timerA === 2,
    `post-underflow continues counting immediately (no fresh load phase), got ${cia.timerA}`);
  ok('MOS6526: timer reload via underflow has no load phase (only LOAD strobe does)');
}

// ── 11: High-byte write to LATCH while timer STOPPED → loads counter ──
// MOS 6526 datasheet: "The timer latch is loaded into the timer on any
// timer underflow, on a force load or following a write to the high
// byte of the prescaler while the timer is [stopped]."
{
  const cia = makeCia();
  cia.write(0x0E, 0x00);                                // ensure stopped
  cia.timerA = 0xAAAA;                                   // distinct sentinel
  cia.write(0x04, 0x42);                                 // latch lo (no load)
  expect(cia.timerA === 0xAAAA, `lo write while stopped: counter unchanged, got $${cia.timerA.toString(16)}`);
  cia.write(0x05, 0x12);                                 // latch hi (LOAD)
  expect(cia.timerA === 0x1242,
    `hi write while stopped: counter = latch ($1242), got $${cia.timerA.toString(16)}`);
  ok('MOS6526: high-byte write while STOPPED loads counter from latch');
}

// ── 12: High-byte write while timer RUNNING → updates latch ONLY ──────
// Same datasheet rule, inverse case: with the timer running, a high-
// byte write must update the latch but leave the running counter
// untouched. The next underflow will reload from the new latch value.
{
  const cia = makeCia();
  cia.write(0x04, 0x10); cia.write(0x05, 0x00);          // latch=$0010
  cia.write(0x0E, 0x11);                                 // start + LOAD
  cia.clock(1); cia.clock(1);                            // 2-clock load phase
  cia.clock(1); cia.clock(1); cia.clock(1);              // count: 16→13
  const before = cia.timerA;
  expect(before === 13, `pre-write running counter = 13, got ${before}`);
  // Write new high byte — must NOT overwrite the live counter.
  cia.write(0x05, 0x55);                                 // latch hi → $5500
  expect(cia.timerA === 13,
    `hi write while running: counter must NOT change, got $${cia.timerA.toString(16)} (was 13)`);
  expect(cia.latchA === 0x5500 || cia.latchA === 0x5510,
    `hi write while running: latch updated, got $${cia.latchA.toString(16)}`);
  ok('MOS6526: high-byte write while RUNNING leaves counter, updates latch only');
}

// ── 13: timerB symmetric — high-byte rule applies to TB too ──────────
{
  const cia = makeCia();
  cia.write(0x06, 0x10); cia.write(0x07, 0x00);          // latchB=$0010
  cia.write(0x0F, 0x11);                                 // start + LOAD
  cia.clock(1); cia.clock(1); cia.clock(1);              // 3-clock load phase
  cia.clock(1); cia.clock(1);                            // count
  const before = cia.timerB;
  cia.write(0x07, 0x55);                                 // hi write while running
  expect(cia.timerB === before,
    `B: hi write while running must NOT change counter, got $${cia.timerB.toString(16)} (was $${before.toString(16)})`);
  ok('MOS6526: timerB high-byte rule symmetric (running → no counter load)');
}

console.log(`\n${testNo} CIA force-load edge spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
