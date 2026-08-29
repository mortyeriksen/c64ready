// Sprite-crunch pending-bit lifecycle, Bauer §3.8.1 rule 7a.
//
// Two related bugs being pinned:
//   (a) `_spriteCrunchPending[s]` was only cleared inside the cycle-16
//       `if (spriteDmaOn[s])` gate. So if $D017 cleared MxYE during
//       cycle 15 of a line where the sprite had no DMA, the pending bit
//       latched and was never consumed — leaking into the *next* line
//       where DMA was on, applying the bit-interleave formula to an
//       unrelated row.
//
//   (b) The trigger was tested as a level (`(val>>s)&1 === 0`) rather
//       than the transition Bauer specifies ("the CPU cleared MxYE").
//       In normal flow rule 1 keeps FF=1 whenever MxYE=0, so the FF=0
//       guard masks the false positive — but staged state with FF=0 +
//       MxYE=0 + a redundant write of 0 would still latch pending. The
//       transition test (`(oldVal & ~val) & bit`) is robust against
//       that.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 200000;
  while (--safety) {
    if (vic.raster === raster && vic.cycleInLine === cycle) return;
    vic.clock(1);
  }
  throw new Error(`driveTo timed out at raster=${vic.raster} cycle=${vic.cycleInLine}`);
}

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// ── 1: cycle 16 always clears pending, even when DMA is off ────────────
{
  const vic = makeVic();
  // Stage: at cycle 15, sprite 3 DMA is OFF, MxYE was 1, FF was 0.
  // CPU clears MxYE bit 3 → transition + FF guard → pending set.
  driveTo(vic, 0x40, 15);
  vic.regs[0x17] = 0xFF;          // all MxYE on
  vic.spriteYExpandFF[3] = 0;
  vic.spriteDmaOn[3] = 0;
  vic.write(0x17, 0xF7);          // clear bit 3 only
  expect(vic._spriteCrunchPending[3] === 1, `cycle 15: pending latched after MxYE 1→0 transition with FF=0`);
  // Advance through cycle 16 — pending MUST clear regardless of DMA gate.
  vic.clock(1);
  expect(vic.cycleInLine === 16, `now at cycle 16`);
  expect(vic._spriteCrunchPending[3] === 0, `cycle 16: pending cleared even though DMA was off`);
  ok('Cycle-16 clear of _spriteCrunchPending is unconditional (no DMA gate)');
}

// ── 2: a stale pending bit cannot leak across lines into a future row ─
{
  const vic = makeVic();
  // Line N: sprite 5 DMA off, FF=0, clear MxYE → pending latched.
  driveTo(vic, 0x40, 15);
  vic.regs[0x17] = 0xFF;
  vic.spriteYExpandFF[5] = 0;
  vic.spriteDmaOn[5] = 0;
  vic.write(0x17, 0xDF);          // clear bit 5
  expect(vic._spriteCrunchPending[5] === 1, `pending latched line N c15`);
  driveTo(vic, 0x40, 17);
  expect(vic._spriteCrunchPending[5] === 0, `pending cleared by cycle 16 of line N`);

  // Line N+5: sprite 5 DMA is now on with FF=1 and a known MC/MCBASE.
  // If the cycle-16 clear had been gated on DMA, pending would still be
  // 1 here and would mis-apply the bit-interleave to MCBASE. Verify the
  // clean MCBASE := MC path runs.
  driveTo(vic, 0x45, 14);
  vic.spriteDmaOn[5] = 1;
  vic.spriteYExpandFF[5] = 1;
  vic.spriteMC[5] = 0x09;
  vic.spriteMCBase[5] = 0x12;     // would mismatch under crunch formula
  driveTo(vic, 0x45, 17);
  expect(vic.spriteMCBase[5] === 0x09, `clean MCBASE := MC at cycle 16 (got $${vic.spriteMCBase[5].toString(16)})`);
  // Crunch formula on (mcb=0x12, mc=0x09):
  //   interleave = (0x2A & (0x12 & 0x09)) | (0x15 & (0x12 | 0x09)) = 0x11
  // — would have been 0x11, not 0x09. This is the assertion that catches
  // the leak.
  expect(vic.spriteMCBase[5] !== 0x11, `did NOT run crunch formula (would have given 0x11)`);
  ok('Stale pending bit does not leak across lines into a later DMA-on cycle 16');
}

// ── 3: $D017 transition test (1→0 only triggers, redundant 0 does not) ─
{
  const vic = makeVic();
  driveTo(vic, 0x40, 15);
  // Stage MxYE bit 2 already 0, FF=0 (rule-1 violating, only reachable
  // via direct staging — exactly the bug class the transition test
  // protects against).
  vic.regs[0x17] = 0xFB;          // bit 2 already 0
  vic.spriteYExpandFF[2] = 0;
  // Redundant write that re-asserts bit 2 = 0 (no transition).
  vic.write(0x17, 0xFB);
  expect(vic._spriteCrunchPending[2] === 0, `no-transition write does NOT latch pending`);

  // Now do a real 1→0 transition on bit 6 with FF=0 — should latch.
  vic.regs[0x17] = 0x40;          // bit 6 currently 1, others 0
  vic.spriteYExpandFF[6] = 0;
  vic.write(0x17, 0x00);          // clear bit 6
  expect(vic._spriteCrunchPending[6] === 1, `actual 1→0 transition with FF=0 latches pending`);
  ok('$D017 crunch trigger is transition-gated, not level-gated');
}

// ── 4: real cycle-15 clear with the FF ALREADY SET does NOT latch ─────
// Bauer §3.8.1 rule 7a gates the crunch on the FF being UNSET before the
// clear. A real 1→0 edge at c15 with the FF already set therefore latches
// nothing — the line takes the clean MCBASE := MC at cycle 16. (The
// addendum's rule-7 rewrite reads as if the gate is gone, but Coma Light
// 13's sprite-stretch release is the case that proves the gate is real —
// see sprite-crunch-addendum-spec-test.js. VICE's sprite-crunch testprog
// only covers FF=0 crunches, so it is unaffected.)
{
  const vic = makeVic();
  driveTo(vic, 0x40, 15);
  vic.regs[0x17] = 0xFF;
  vic.spriteYExpandFF[1] = 1;       // FF already set before the clear
  vic.write(0x17, 0xFD);          // clear bit 1 (real 1→0 edge)
  expect(vic._spriteCrunchPending[1] === 0,
    `rule 7a: 1→0 transition with FF already set does NOT latch pending`);
  ok('Bauer 7a: $D017 c15 1→0 edge with FF already set does NOT latch crunch (FF gate)');
}

// ── 5: real-flow round trip — DMA-on sprite hits crunch correctly ──────
{
  const vic = makeVic();
  driveTo(vic, 0x40, 14);
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 0;
  vic.spriteMC[0] = 0x05;
  vic.spriteMCBase[0] = 0x32;
  vic.regs[0x17] = 0x01;          // bit 0 = 1
  driveTo(vic, 0x40, 15);
  vic.write(0x17, 0x00);          // 1→0 transition + FF=0 + cycle 15
  expect(vic._spriteCrunchPending[0] === 1, `crunch pending latched`);
  driveTo(vic, 0x40, 17);
  // Crunch formula: (0x2A & (0x32 & 0x05)) | (0x15 & (0x32 | 0x05))
  //               = (0x2A & 0x00)         | (0x15 & 0x37)
  //               = 0x00                  | 0x15
  //               = 0x15
  expect(vic.spriteMCBase[0] === 0x15, `crunch formula applied (MCBASE=$15, got $${vic.spriteMCBase[0].toString(16)})`);
  expect(vic._spriteCrunchPending[0] === 0, `pending consumed`);
  ok('Real-flow DMA-on crunch path still applies the interleave formula');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
