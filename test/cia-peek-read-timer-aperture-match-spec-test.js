// CIA peek() must return the SAME value as read() for the timer registers
// ($Dx04-$Dx07), so the CPU opcode PREDECODE agrees with the real fetch.
//
// The 6510 dispatch path predecodes the next opcode via peek(this.pc) →
// mem.peekForCpu() → _peekIO() → cia.peek() BEFORE queuing the bus-accurate
// micro-ops; the first micro-op then does the real fetch via cia.read(). For
// code that executes live CIA timer registers as opcodes (the Hat's $fffa→CIA
// trick), if peek() and read() disagree the CPU decodes the WRONG instruction.
//
// read() applies the #14 underflow read aperture: a running PHI2 timer that is
// momentarily 0 at underflow reads back the LATCH (not the transient 0). peek()
// previously returned the RAW timer for $04-$07 → a predecode/fetch mismatch
// exactly at the underflow cycle. This pins peek()==read() for all four timer
// bytes, in the aperture case AND the non-aperture (stopped/normal) cases.
//
// Refs: friend review 2026-06-28 ("CPU predecode can disagree with the real CIA
// timer opcode fetch"); cia.js read()/peek() taVal/tbVal.

import { CIA } from '../src/cia.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`); currentFailures = [];
  }
}
function makeCia() { const c = new CIA(1); c.irqHandler = () => {}; return c; }
const eq4 = (cia) => [0x04, 0x05, 0x06, 0x07].every(r => (cia.peek(r) & 0xff) === (cia.read(r) & 0xff));

// ── 1: running PHI2 timer momentarily at 0 (the underflow aperture) — peek
//      must equal read AND return the LATCH, not the raw 0. This is the case
//      the friend flagged; pre-fix peek returned 0 here. ───────────────────────
{
  const cia = makeCia();
  cia.cra = 0x01;            // run + PHI2 count (so (cra & 0x21) === 0x01)
  cia.crb = 0x01;            // run + PHI2 count (so (crb & 0x61) === 0x01)
  cia.latchA = 0x1234; cia.latchB = 0x5678;
  cia.timerA = 0x0000; cia.timerB = 0x0000;   // transient underflow 0
  cia._timerReadWindow = false;
  // peek FIRST (it is the side-effect-free predecode), then read.
  const pA = (cia.peek(0x04) | (cia.peek(0x05) << 8));
  const rA = (cia.read(0x04) | (cia.read(0x05) << 8));
  const pB = (cia.peek(0x06) | (cia.peek(0x07) << 8));
  const rB = (cia.read(0x06) | (cia.read(0x07) << 8));
  expect(pA === rA, `Timer A: peek $${pA.toString(16)} must equal read $${rA.toString(16)}`);
  expect(pB === rB, `Timer B: peek $${pB.toString(16)} must equal read $${rB.toString(16)}`);
  expect(pA === 0x1234, `Timer A aperture: peek must return the LATCH $1234 (not raw 0), got $${pA.toString(16)}`);
  expect(pB === 0x5678, `Timer B aperture: peek must return the LATCH $5678 (not raw 0), got $${pB.toString(16)}`);
  ok('CIA: running-PHI2-timer-at-0 — peek == read == latch (predecode matches fetch)');
}

// ── 2: STOPPED timer at 0 — aperture must NOT apply (matches read): both 0 ───
{
  const cia = makeCia();
  cia.cra = 0x00; cia.crb = 0x00;             // stopped
  cia.latchA = 0x1234; cia.latchB = 0x5678;
  cia.timerA = 0x0000; cia.timerB = 0x0000;
  cia._timerReadWindow = false;
  expect(eq4(cia), `stopped: peek must equal read for $04-$07`);
  expect((cia.peek(0x04) & 0xff) === 0 && (cia.peek(0x06) & 0xff) === 0,
    `stopped timer at 0 reads 0 (aperture gated off, same as read)`);
  ok('CIA: stopped timer at 0 — peek == read == 0 (aperture conditional, mirrors read)');
}

// ── 3: normal running timer (non-zero) — peek == read == raw counter ─────────
{
  const cia = makeCia();
  cia.cra = 0x01; cia.crb = 0x01;
  cia.latchA = 0xFFFF; cia.latchB = 0xFFFF;
  cia.timerA = 0x0042; cia.timerB = 0x00A5;
  cia._timerReadWindow = false;
  expect(eq4(cia), `running non-zero: peek must equal read for $04-$07`);
  expect((cia.peek(0x04) & 0xff) === 0x42 && (cia.peek(0x06) & 0xff) === 0xA5,
    `running non-zero: peek returns the live counter`);
  ok('CIA: running timer (non-zero) — peek == read == live counter');
}

console.log(`\n${testNo} CIA peek/read timer-aperture-match spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
