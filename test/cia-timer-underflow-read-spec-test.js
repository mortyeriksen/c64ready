// MOS 6526 CIA — a RUNNING timer read at the underflow returns the RELOADED
// latch value, never a stable 0. (#14)
//
// Spec source: a deterministic VICE x64sc Timer-A oracle with NEWCIA=0 and
// randomized autostart delay disabled. Running an identical
// force-load+START+12×`lda $dc04` PRG (display
// disabled so VIC bad-line DMA doesn't displace the reads) in VICE and our
// emulator matches BYTE-FOR-BYTE across latches 0..20 × 12 reads (0/252) only
// when a running timer momentarily at 0 reports the reloaded latch on a read.
// The counter still passes through 0 internally, so the underflow RATE
// (period = latch+1) and the Timer-B cascade are unchanged — this is purely the
// read aperture, NOT a counter/period change. A STOPPED timer at 0 reads 0.
//
// Friend's #14: "the waiting count at 0 immediately reloads — no visible stable
// 0." Confirmed: VICE never exposes 0 on a running timer; it shows the latch.

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

// ── 1: RUNNING Timer A momentarily 0 → $DC04/05 read returns the latch ───────
{
  const c = makeCia();
  c.latchA = 0x1234;
  c.timerA = 0x0000;          // the underflow cycle (counter momentarily 0)
  c.cra = 0x01;               // RUNNING
  expect(c.read(0x04) === 0x34, `TA lo read at underflow = latch lo $34, got $${c.read(0x04).toString(16)}`);
  expect(c.read(0x05) === 0x12, `TA hi read at underflow = latch hi $12, got $${c.read(0x05).toString(16)}`);
  ok('running Timer A at underflow reads the reloaded latch, not 0');
}

// ── 2: STOPPED Timer A at 0 → reads 0 (the real counter) ─────────────────────
{
  const c = makeCia();
  c.latchA = 0x1234;
  c.timerA = 0x0000;
  c.cra = 0x00;               // STOPPED
  expect(c.read(0x04) === 0x00 && c.read(0x05) === 0x00,
    `stopped TA at 0 reads 0, got $${c.read(0x05).toString(16)}${c.read(0x04).toString(16)}`);
  ok('stopped Timer A at 0 reads 0 (no latch substitution)');
}

// ── 3: RUNNING Timer A at a NON-zero count → reads the counter unchanged ──────
{
  const c = makeCia();
  c.latchA = 0x1234;
  c.timerA = 0x0007;
  c.cra = 0x01;
  expect(c.read(0x04) === 0x07 && c.read(0x05) === 0x00,
    `running TA mid-count reads the counter $0007, got $${c.read(0x05).toString(16)}${c.read(0x04).toString(16)}`);
  ok('running Timer A mid-count reads the live counter (no substitution off-underflow)');
}

// ── 4: Timer B has the same underflow read aperture ──────────────────────────
{
  const c = makeCia();
  c.latchB = 0x00AB; c.timerB = 0x0000; c.crb = 0x01;          // running, at underflow
  expect(c.read(0x06) === 0xAB && c.read(0x07) === 0x00,
    `running TB at underflow reads latch $00AB, got $${c.read(0x07).toString(16)}${c.read(0x06).toString(16)}`);
  c.crb = 0x00;                                                 // stopped
  expect(c.read(0x06) === 0x00, `stopped TB at 0 reads 0`);
  ok('Timer B underflow read aperture matches Timer A (running→latch, stopped→0)');
}

// ── 5: integration — a real force-load+START countdown never reads 0 while
//      running, and the underflow rate is unchanged (period = latch+1). ───────
{
  const c = makeCia();
  c.write(0x04, 0x03); c.write(0x05, 0x00);   // latch A = 3
  c.write(0x0D, 0x81);                         // enable TA IRQ (to count underflows)
  c.write(0x0E, 0x11);                         // force-load + start
  let zeroSeenWhileRunning = false, underflows = 0;
  let prevIcr = c.icrStatus & 0x01;
  for (let i = 0; i < 40; i++) {
    c.clock(1);
    // read $DC04 the way the CPU would (no snapshot window here → live counter)
    const v = c.read(0x04);
    if (v === 0x00 && (c.cra & 0x01)) zeroSeenWhileRunning = true;
    const nowIcr = c.icrStatus & 0x01;
    if (nowIcr && !prevIcr) underflows++;
    prevIcr = nowIcr;
    c.icrStatus &= ~0x01;     // ack so the next underflow is detectable
  }
  expect(!zeroSeenWhileRunning, `a running Timer A is never read as 0 (underflow shows the latch)`);
  expect(underflows >= 8, `underflows still occur at the latch+1 rate (saw ${underflows} in 40 clocks, latch=3 → period 4)`);
  ok('force-load+START countdown: never reads 0 while running, rate (latch+1) unchanged');
}

console.log(`\n${testNo} Timer underflow-read spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
