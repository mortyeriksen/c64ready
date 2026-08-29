// CIA timer cascade & TOD spec audit, derived from the MOS6526
// datasheet: timer modes, force-load, latch-vs-running reads, timer-B
// chaining, TOD ticks, alarm match, and the IRQ-status read-clear
// semantic. Each test cites the datasheet rule and computes the expected
// value from the rule.

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

// ── 1: TimerA force-load ($DC0E bit 4) loads from latch ─────────────────
// MOS6526: writing 1 to CRA bit 4 (LOAD) forces timer A to copy from the
// latch. The bit auto-clears (write-strobe).
{
  const cia = new CIA(1);
  cia.write(0x04, 0x42);     // latch lo
  cia.write(0x05, 0x12);     // latch hi → latchA = $1242
  cia.timerA = 0;
  cia.write(0x0E, 0x10);     // CRA force-load
  expect(cia.timerA === 0x1242,
    `force-load: timerA must = latch ($1242), got $${cia.timerA.toString(16)}`);
  // CRA bit 4 must auto-clear (cra reads back without bit 4).
  expect((cia.cra & 0x10) === 0,
    `force-load is write-strobe: CRA bit 4 must auto-clear`);
  ok('MOS6526: $DC0E bit 4 force-loads timerA from latch and auto-clears');
}

// ── 2: TimerA start/stop via $DC0E bit 0 ────────────────────────────────
// Bit 0=1 starts the timer; bit 0=0 stops it WITHOUT reloading. The stop
// takes effect with a ONE-CYCLE delay (the 6526 control-write pipeline): the
// timer does one more count after the stop write, then freezes. Verified
// against real hardware by testprogs/VICII/split-tests/bascan (tests 3 & 6
// read $dc04 right after a CRA stop/RMW; an immediate-stop model reads one too
// high there). VICE passes bascan.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x10); cia.write(0x05, 0x00);  // latch=$0010
  cia.write(0x0E, 0x11);     // start + force-load → timerA=16
  for (let i = 0; i < 5; i++) cia.clock(1);
  const stopVal = cia.timerA;
  cia.write(0x0E, 0x00);     // stop (bit 0 cleared, no force-load)
  cia.clock(1);              // one-cycle stop delay: one final count
  const afterStop = cia.timerA;
  expect(afterStop === ((stopVal - 1) & 0xFFFF),
    `stop has a 1-cycle delay (one final count): ${stopVal}→${afterStop}, want ${(stopVal - 1) & 0xFFFF}`);
  for (let i = 0; i < 5; i++) cia.clock(1);
  expect(cia.timerA === afterStop,
    `then frozen — no further count or reload, got ${afterStop}→${cia.timerA}`);
  ok('MOS6526: $DC0E bit 0 = 0 stops timerA (1-cycle delay, then no reload)');
}

// ── 3: TimerA reads return current running value ────────────────────────
// Per datasheet $DC04/$DC05 read returns the live counter. Verify by
// reading after a known number of clocks.
//
// Note: writing CRA with bit 4 (force-load) suppresses the FIRST 2 counts
// (= "load" phase) in the raw cia.clock() primitive. The machine clocks the
// CIA at phi1 (before the CPU's phi2 write), so a force-load write is first
// seen by the next cycle's clock — that extra cycle + this 2-clock phase
// reproduce the 3-clock NET load phase sb_sprite_fetch's stable-IRQ chain
// needs (sty $d016 at cycle 56). These unit tests drive cia.clock() directly,
// so they pin the raw 2-clock phase. See cia-force-load-edge-spec-test header.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x64); cia.write(0x05, 0x00);  // latch=100
  cia.write(0x0E, 0x11);     // start + force-load (2-clock load phase)
  for (let i = 0; i < 50; i++) cia.clock(1);
  const expected = 100 - 48;  // = 52 (50 - 2 = 48 decrements)
  const read = cia.read(0x04) | (cia.read(0x05) << 8);
  expect(read === expected,
    `running timerA after 50 clocks (incl. 2-clock load phase): expected ${expected}, got ${read}`);
  ok('MOS6526: $DC04/$DC05 read returns live running counter');
}

// ── 4: TimerA latch write while running does not reload ─────────────────
// Datasheet: if timer is running (CRA bit 0 = 1), writing to the LATCH
// registers ($DC04/$DC05) only updates the LATCH — the running timer
// continues to count from its current value. Reload happens at next
// underflow.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x64); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x11);     // start
  for (let i = 0; i < 30; i++) cia.clock(1);
  const before = cia.timerA;
  cia.write(0x04, 0xFF); cia.write(0x05, 0xFF);  // change latch
  expect(cia.timerA === before,
    `latch write while running must NOT reload timerA (still at ${before}, got ${cia.timerA})`);
  expect(cia.latchA === 0xFFFF,
    `latch write must update the latch even though timer keeps running`);
  ok('MOS6526: latch write while running updates latch, not running timer');
}

// ── 5: TimerA 1-shot mode auto-stops after underflow ────────────────────
// Datasheet CRA bit 3: 0 = continuous (auto-reload), 1 = one-shot (stop).
// Total to first underflow with force-load: 3 (load phase) + latch
// (count) + 1 (underflow/reload) = 9 clocks for latch=5. Run 10 to be safe.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x05); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x19);     // start + 1-shot + force-load
  for (let i = 0; i < 10; i++) cia.clock(1);
  expect((cia.cra & 0x01) === 0,
    `1-shot timerA: CRA bit 0 (start) must auto-clear after underflow`);
  ok('MOS6526: 1-shot timerA auto-stops on underflow (CRA bit 0 cleared)');
}

// ── 6: TimerA continuous mode reloads from latch on underflow ───────────
// Datasheet CRA bit 3 = 0: timer reloads from latch and keeps running.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x11);     // start + continuous + force-load
  // 100 cycles ÷ (latch+1=3) = 33 underflows. Timer should still be running.
  for (let i = 0; i < 100; i++) cia.clock(1);
  expect((cia.cra & 0x01) === 1,
    `continuous timerA: must keep running across many underflows`);
  ok('MOS6526: continuous timerA stays running across underflows');
}

// ── 7: TimerB chained from TA (CRB bits 5,6 = 10) ───────────────────────
// Datasheet CRB bits 6:5 = 10 → timerB is clocked by TA underflows.
// With latchA=2 (TA underflow every 3 cycles) and latchB=3 (TB underflow
// every 4 TA underflows = 12 CIA cycles), TB IRQ should fire within
// roughly 12 CIA clocks.
{
  let irqRaised = false;
  const cia = new CIA(1);
  cia.irqHandler = () => { irqRaised = true; };
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);   // TA latch=2
  cia.write(0x0E, 0b00010001);                     // TA: start, continuous, force-load
  cia.write(0x06, 0x03); cia.write(0x07, 0x00);   // TB latch=3
  cia.write(0x0D, 0x82);                            // ICR: enable TB mask
  cia.write(0x0F, 0b01010001);                     // TB: start, continuous, count TA, force-load
  for (let i = 0; i < 50; i++) cia.clock(1);
  expect(irqRaised === true,
    `TB chained from TA: IRQ must fire within 50 cycles`);
  ok('MOS6526: TB CRB bits 5,6=10 chains from TA underflows');
}

// ── 8: TOD PAL frequency (CRA bit 7 = 1) advances 1 tenth per 5 ticks ───
// Datasheet: CRA bit 7 selects TOD divider source. PAL (50 Hz) = 5 ticks
// per 100 ms tenth; NTSC (60 Hz) = 6 ticks. Our impl uses tick50Hz.
{
  const cia = new CIA(1);
  cia.write(0x0E, 0x80);     // CRA bit 7 = 1 → 50Hz mode
  cia.tod10 = 0;
  for (let i = 0; i < 5; i++) cia.tick50Hz();
  expect(cia.tod10 === 1,
    `PAL TOD: 5 50Hz ticks → 1 tenth, got ${cia.tod10}`);
  for (let i = 0; i < 5; i++) cia.tick50Hz();
  expect(cia.tod10 === 2,
    `PAL TOD: another 5 ticks → 2 tenths`);
  ok('MOS6526: PAL TOD ($DC0E.7=1) advances 1 tenth every 5 50Hz ticks');
}

// ── 9: TOD alarm fires when current time matches alarm regs ─────────────
// Datasheet: writing $DC08..$DC0B with CRB bit 7 = 1 sets alarm; with
// bit 7 = 0 sets time. Alarm match raises ICR bit 2.
{
  let alarm = false;
  const cia = new CIA(1);
  cia.irqHandler = () => { alarm = (cia.icrStatus & 0x04) !== 0; };
  cia.write(0x0D, 0x84);     // enable alarm IRQ (bit 2)
  cia.write(0x0E, 0x80);     // PAL TOD
  // Set TOD = 12:34:56.7
  cia.write(0x0F, 0x00);     // CRB bit 7 = 0 → write TOD
  cia.write(0x0B, 0x12); cia.write(0x0A, 0x34); cia.write(0x09, 0x56); cia.write(0x08, 0x07);
  // Set alarm to 12:34:56.8 (one tenth later)
  cia.write(0x0F, 0x80);     // CRB bit 7 = 1 → write alarm
  cia.write(0x0B, 0x12); cia.write(0x0A, 0x34); cia.write(0x09, 0x56); cia.write(0x08, 0x08);
  // Tick 1 tenth (5 PAL ticks).
  for (let i = 0; i < 5; i++) cia.tick50Hz();
  expect((cia.icrStatus & 0x04) !== 0,
    `alarm: ICR bit 2 must set when TOD matches alarm regs`);
  ok('MOS6526: TOD alarm match raises ICR bit 2');
}

// ── 10: $DC0D read clears IRQ status latch (read-and-clear) ─────────────
// Datasheet: reading the ICR returns the status mask AND clears all bits
// in the same operation. This is a critical timing detail; some loaders
// rely on it for IRQ acknowledgment.
{
  const cia = new CIA(1);
  // Data bits (TA, TB) live in icrStatus 0-4; the IR bit (bit 7) is the IR
  // latch (datasheet sheet 7), modelled separately as _irLatch. Set up a
  // pending interrupt with the IR already latched.
  cia.icrStatus = 0x03;       // TA + TB data bits
  cia._irLatch = true;        // IR latched → bit 7 reads set
  const v1 = cia.read(0x0D);
  expect((v1 & 0x83) === 0x83,
    `$DC0D first read returns latched bits, got $${v1.toString(16)}`);
  expect(cia.icrStatus === 0 && cia._irLatch === false,
    `$DC0D read must clear ICR status + IR latch entirely (not just W1C the read bits)`);
  ok('MOS6526: $DC0D read returns and clears ICR status atomically');
}

// ── 11: Underflow period = latch+1 cycles (PAL-rasterline alignment) ────
// MOS6526 datasheet (page 6): "the timer will count from latched value to
// zero, generate interrupt, reload the latched value and repeat".
//
// With force-load (CRA bit 4) the raw cia.clock() primitive has a 2-clock
// load phase before counting begins (test-side spec deviation — see cia-
// force-load-edge-spec-test header). After the load phase the period is N+1
// cycles. With latch=$3E=62 the repeating period is 63 cycles, exactly one
// PAL rasterline.
//
// Concretely with latch=N and force-load + start:
//   T0        : timer = N            (force-load, write cycle)
//   T+1,2     : timer = N             (2-clock load phase, no counting)
//   T+3       : timer = N-1
//   ...
//   T+2+N     : timer = 0
//   T+3+N     : timer = N (reload), underflow IRQ raised
// First underflow at T+N+3; subsequent period = N+1.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);  // latch = 2
  cia.write(0x0E, 0x11);                          // force-load + start, timer=2
  expect(cia.timerA === 2, `force-load: timer=2, got ${cia.timerA}`);
  cia.clock(1); cia.clock(1);                     // 2-clock load phase
  expect(cia.timerA === 2, `still in load phase: timer=2, got ${cia.timerA}`);
  cia.clock(1);
  expect(cia.timerA === 1, `1 clock after load phase: timer=1, got ${cia.timerA}`);
  cia.clock(1);
  expect(cia.timerA === 0, `2 clocks after load phase: timer=0, got ${cia.timerA}`);
  cia.clock(1);
  expect(cia.timerA === 2,
    `latch+1=3 clocks after load phase: timer must reload to latch (=2), got ${cia.timerA} (would indicate a latch+2 period bug)`);
  ok('MOS6526: timer period = latch+1 cycles (= 3 cycles for latch=2) post-load');
}

// ── 12: Underflow IRQ flag raised on reload cycle, not on zero cycle ────
// The IRQ flag (ICR bit 0 for Timer A) is raised on the SAME clock that
// the timer reloads from latch — i.e. the cycle AFTER the timer reads
// zero. This matters for any code that polls $DC0D for the underflow
// event. Pin it so a future "raise IRQ when reaching zero" regression
// would fail this test rather than silently shifting demo timing.
//
// Force-load adds a 2-clock load phase in the raw cia.clock() primitive
// (test-side spec deviation — see cia-force-load-edge-spec-test header) so
// the first underflow lands at clock T+N+3 with latch=N, not T+N+1.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);   // latch = 2
  cia.write(0x0E, 0x11);                           // force-load + start
  cia.icrStatus = 0;                               // clear any prior bits
  cia.clock(1); cia.clock(1);                      // 2-clock load phase
  cia.clock(1);                                    // counts: 2→1
  expect((cia.icrStatus & 0x01) === 0,
    `post-load+1: timer=1, no underflow yet, ICR bit 0 must be clear`);
  cia.clock(1);                                    // 1→0
  expect((cia.icrStatus & 0x01) === 0,
    `post-load+2: timer=0 but no IRQ yet (datasheet: IRQ on reload cycle, not zero cycle)`);
  cia.clock(1);                                    // reload + IRQ
  expect((cia.icrStatus & 0x01) !== 0,
    `post-load+3 (reload cycle): underflow IRQ flag must be raised`);
  ok('MOS6526: underflow IRQ raised on reload cycle, not zero cycle');
}

// ── 13: $DC04 read inside a master-cycle window returns the snapshot ────
// Bus-cycle ordering note: machine.js calls cia.beginMasterCycle BEFORE
// cia.clock() so the CPU's phi2 read of $DC04 returns the timer value as
// of the start of this master cycle (= the value at the END of the
// previous master cycle's count). At phi2 of cycle K, real silicon's
// counter still holds the post-count of cycle K-1 (= pre-count of cycle
// K's edge), so this matches the datasheet's "live phi2" semantic.
//
// Empirical pin: clock-then-snapshot (post-count of cycle K) makes
// `lda $dc04` in sb_sprite_fetch's asr-tree read 1 LSB too low, deepening
// the stable-IRQ deficit from 2 to 3 cycles. snapshot-then-clock is
// correct.
//
// This test pins both behaviors: live read OUTSIDE the window, snapshot
// read INSIDE it. If the read latency model changes, this test will fail
// and prompt a deliberate spec re-decision rather than silent drift.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x64); cia.write(0x05, 0x00);   // latch = 100
  cia.write(0x0E, 0x11);                           // force-load + start

  // 1) Outside window (= what cia-timer-spec-test 3 already tests):
  //    reads return live counter. With force-load's 2-clock load phase
  //    (test-side spec deviation), the counter has only decremented
  //    (10 - 2) = 8 times.
  for (let i = 0; i < 10; i++) cia.clock(1);
  const outsideRead = cia.read(0x04) | (cia.read(0x05) << 8);
  expect(outsideRead === 92,
    `outside read window: live read after 10 clocks (incl. 2-clock load) must be 92, got ${outsideRead}`);

  // 2) Inside a master-cycle window: read returns the snapshot from
  //    beginMasterCycle, NOT the live (post-count) value.
  cia.beginMasterCycle();          // snapshots timerA = 92
  cia.clock(1);                    // counts: timer 92→91
  const insideRead = cia.read(0x04) | (cia.read(0x05) << 8);
  expect(insideRead === 92,
    `inside read window: read must return snapshot (92), got live (${insideRead}). If this fails because we returned 91, the snapshot path was bypassed.`);
  cia.endMasterCycle();
  ok('MOS6526: $DC04 read returns snapshot inside master-cycle window, live outside');
}

// ── TOD writes: hours halts the clock, tenths releases it ───────────────
// MOS6526: writing the hours register stops the TOD so a full time can be
// set without a carry racing in; writing tenths restarts it.
{
  const cia = new CIA(1);
  cia.write(0x0B, 0x12);                             // hr write → halt
  expect(cia.todHalted === true, 'writing hr halts TOD');
  for (let i = 0; i < 60; i++) cia.tick50Hz();
  expect(cia.tod10 === 0, 'halted TOD does not advance under tick50Hz');
  cia.write(0x08, 0x00);                             // tenths write → run
  expect(cia.todHalted === false, 'writing tenths unhalts TOD');
  for (let i = 0; i < 6; i++) cia.tick50Hz();
  expect(cia.tod10 === 1, 'unhalted TOD now advances');
  ok('MOS6526: TOD halts on an hours write and runs again on a tenths write');
}

// ── TOD reads: hours freezes the latched time, tenths releases it ───────
{
  const cia = new CIA(1);
  cia.write(0x0B, 0x12); cia.write(0x0A, 0x34); cia.write(0x09, 0x56); cia.write(0x08, 0x07);
  cia.read(0x0B);                                    // freeze
  expect(cia.todLatched === true, 'reading hr freezes the display');
  for (let i = 0; i < 6; i++) cia.tick50Hz();        // TOD advances underneath
  expect(cia.read(0x08) === 7, 'tenths read returns frozen value');
  expect(cia.todLatched === false, 'reading tenths unfreezes the display');
  expect(cia.read(0x08) === 8, 'subsequent tenths read returns live value');
  ok('MOS6526: TOD read of hours latches the time until tenths is read');
}

// ── ICR: one read returns and clears every latched source ───────────────
{
  const cia = new CIA(1);
  cia.icrMask = 0x03;
  cia.icrStatus = 0x03;                              // TA + TB data bits pending
  cia._irLatch = true;                               // IR latched → bit 7 reads set
  const v = cia.read(0x0D);
  expect((v & 0x83) === 0x83,
    `ICR read returns all latched bits in a single read (got 0x${v.toString(16)})`);
  expect(cia.icrStatus === 0, 'single read clears all bits');
  ok('MOS6526: $DC0D read returns and clears every latched source at once');
}

// ── ICR mask write: $7F (bit 7 = 0) clears the whole mask ───────────────
{
  const cia = new CIA(1);
  cia.icrMask = 0x1F;
  cia.write(0x0D, 0x7F);
  expect(cia.icrMask === 0, 'writing $7F clears the entire mask');
  ok('MOS6526: $DC0D write of $7F clears all mask bits');
}

// ── Two CIAs keep independent ICR state ─────────────────────────────────
{
  const cia1 = new CIA(1);
  const cia2 = new CIA(2);
  cia1.icrMask = 0x01; cia1.icrStatus = 0x01; cia1._irLatch = true;
  cia2.icrMask = 0x01; cia2.icrStatus = 0x00;
  expect(cia1.irqState === true, 'CIA1 has pending IRQ');
  expect(cia2.irqState === false, 'CIA2 has no pending IRQ (separate state)');
  ok('MOS6526: CIA1 and CIA2 maintain independent ICR state');
}

console.log(`\n${testNo} CIA timer / TOD spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
