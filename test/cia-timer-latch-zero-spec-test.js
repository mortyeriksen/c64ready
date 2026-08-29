// CIA timer latch = 0 spec: a latched value of 0 is LEGAL and means
// "underflow every cycle" (period 1) — it must NOT be coerced to $FFFF.
//
// MOS6526: the timer counts the latched value down to zero, underflows,
// reloads the latch and repeats. A latch of 0 therefore reloads to 0 and
// underflows on every following count (the shortest possible period).
//
// REGRESSION PINNED: every timer load site used `latch || 0xFFFF`, which
// turned a 0 latch into the MAXIMUM period ($FFFF = 65536 cycles). The TLR
// "cia-int" testprog loads Timer B with values 0..23; the value-0 column never
// produced an interrupt because our timer was off counting 65536 cycles
// instead of underflowing immediately.
//
// NOTE on the 2-clock load phase: writing CRA/CRB with the force-load bit (4)
// AND start bit (0) holds the loaded value for 2 raw cia.clock() ticks before
// counting begins (see cia-force-load-edge-spec-test for why). These tests
// drive cia.clock() directly, so they account for that phase explicitly.

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
const hx = v => '$' + (v & 0xffff).toString(16);

// ── 1: Force-load with latch 0 loads 0 (not $FFFF) ──────────────────────
{
  const cia = new CIA(1);
  cia.write(0x04, 0x00); cia.write(0x05, 0x00);  // latchA = 0
  cia.write(0x0E, 0x10);                          // force-load (no start)
  expect(cia.timerA === 0,
    `force-load latch 0: timerA must be 0, got ${hx(cia.timerA)} (`+
    `$FFFF here = the old "latch || 0xFFFF" coercion bug)`);
  ok('MOS6526: force-load with latch 0 loads 0, not $FFFF');
}

// ── 2: Load-when-stopped via $05 write with latch 0 loads 0 ─────────────
// Writing the timer high byte while the timer is stopped copies latch→timer.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x00);                          // latch lo = 0
  cia.write(0x05, 0x00);                          // latch hi = 0 (timer stopped) → load
  expect(cia.timerA === 0,
    `latch-write while stopped, latch 0: timerA must be 0, got ${hx(cia.timerA)}`);
  ok('MOS6526: $DC05 write (stopped) with latch 0 loads timer to 0');
}

// ── 3: Timer A latch 0 + start → underflow with period 1 ────────────────
// After the 2-clock load phase, a latch-0 timer underflows on the very next
// count and on every count thereafter.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x00); cia.write(0x05, 0x00);  // latchA = 0
  cia.icrStatus = 0;
  cia.write(0x0E, 0x11);                          // force-load + start (continuous)
  cia.clock(1); cia.clock(1);                     // 2-clock load phase (no count)
  expect((cia.icrStatus & 0x01) === 0,
    `during load phase: no underflow yet, ICR bit0 must be clear`);
  cia.clock(1);                                   // first real count: 0 → underflow
  expect((cia.icrStatus & 0x01) !== 0,
    `latch 0, post-load count: Timer A must underflow immediately (period 1), `+
    `ICR bit0 set; got icrStatus=${hx(cia.icrStatus)}`);
  // period 1: clears and re-sets every single clock.
  cia.icrStatus = 0;
  cia.clock(1);
  expect((cia.icrStatus & 0x01) !== 0,
    `latch 0 continuous: must underflow again on the very next clock (period 1)`);
  ok('MOS6526: Timer A latch 0 underflows every cycle (period 1)');
}

// ── 4: Timer B latch 0 + start → underflow with period 1 ────────────────
// Same rule for Timer B (PHI2 count mode). This is the exact cia-int
// timer-value-0 column.
{
  const cia = new CIA(1);
  cia.write(0x06, 0x00); cia.write(0x07, 0x00);  // latchB = 0
  cia.icrStatus = 0;
  cia.write(0x0F, 0x11);                          // force-load + start (continuous, PHI2)
  expect(cia.timerB === 0,
    `force-load latch 0: timerB must be 0, got ${hx(cia.timerB)}`);
  cia.clock(1); cia.clock(1);                     // 2-clock load phase
  cia.clock(1);                                   // 0 → underflow
  expect((cia.icrStatus & 0x02) !== 0,
    `latch 0, post-load count: Timer B must underflow immediately, ICR bit1 set; `+
    `got icrStatus=${hx(cia.icrStatus)}`);
  ok('MOS6526: Timer B latch 0 underflows every cycle (period 1)');
}

// ── 5: One-shot Timer B latch 0 fires once then stops ───────────────────
// Confirms latch-0 cooperates with one-shot mode: a single underflow, then
// the start bit auto-clears.
{
  const cia = new CIA(1);
  cia.write(0x06, 0x00); cia.write(0x07, 0x00);  // latchB = 0
  cia.icrStatus = 0;
  cia.write(0x0F, 0x19);                          // force-load + start + one-shot
  cia.clock(1); cia.clock(1);                     // load phase
  cia.clock(1);                                   // underflow + auto-stop
  expect((cia.icrStatus & 0x02) !== 0,
    `one-shot latch 0: must underflow once, ICR bit1 set`);
  expect((cia.crb & 0x01) === 0,
    `one-shot latch 0: CRB start bit must auto-clear after the single underflow`);
  ok('MOS6526: one-shot Timer B latch 0 fires once then stops');
}

// ── 6: Non-zero latch path is unchanged (no off-by-one from the fix) ─────
// Guard: removing `|| 0xFFFF` must not perturb the normal period = latch+1.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x02); cia.write(0x05, 0x00);  // latchA = 2
  cia.write(0x0E, 0x11);                          // force-load + start
  cia.clock(1); cia.clock(1);                     // load phase
  cia.clock(1); expect(cia.timerA === 1, `latch2 +1: timer=1, got ${hx(cia.timerA)}`);
  cia.clock(1); expect(cia.timerA === 0, `latch2 +2: timer=0, got ${hx(cia.timerA)}`);
  cia.clock(1); expect(cia.timerA === 2, `latch2 +3: reload to 2, got ${hx(cia.timerA)}`);
  ok('MOS6526: non-zero latch period = latch+1 unchanged by the latch-0 fix');
}

console.log(`\n${testNo} CIA timer latch-0 spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
