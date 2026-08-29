// Sprite crunch — Bauer §3.8.1 rule 7a FF gate (vs the VIC-Addendum reading).
//
// Bauer §3.8.1 rule 7a says:
//   "if the CPU has cleared one of the MxYE bits in cycle 15 AND the
//    advance line flip-flop of the corresponding sprite was NOT set,
//    then [crunch fires]"
//
// VIC-Addendum.txt (VICE team rewrite of rules 7+8):
//   "7. In the first phase of cycle 16, it is checked if the expansion
//    flip flop is set. If so, MCBASE load from MC, UNLESS the CPU
//    cleared the Y expansion bit in $d017 in the second phase of
//    cycle 15, in which case MCBASE is set to [bit-interleave]."
//
// The addendum's rule-7 wording reads as if the FF gate is gone: it checks
// the FF at cycle 16, by which point rule 1 has already forced FF=1 from
// the c15 clear. But that is a measurement artifact — the gate Bauer 7a
// states is on the FF state BEFORE the clear, and it is REAL. Coma Light
// 13's sprite-stretch RELEASE is the discriminating case: there the
// release STX $D017 lands at c15 with the FF already 1 (the prior line's
// rule-3 toggle). An ungated crunch scrambles MCBASE off the ×3 grid (→ 1
// instead of MC), so the eight stretched sprites stay DMA-active ~22 lines
// too long and over-steal the FLI-plasma IRQ handler into a raster-78
// overrun (flickering flat colour bands). With the gate restored, the
// release runs the clean MCBASE := MC and the sprites end on schedule.
//
// VICE's sprite-crunch testprog only exercises FF=0 crunches (where Bauer
// and the addendum agree), so it passes either way — the FF=1 case is
// unconstrained by that testprog and is what these tests now pin to spec.
//
// Implementation status: src/vic2.js gates the crunch latch on the FF
// having been UNSET before the c15 clear (Bauer 7a). The assertions below
// are HARD — a regression to the ungated addendum reading must fail CI.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

function driveTo(vic, targetRaster, targetCycle) {
  let safety = 200000;
  while (--safety) {
    if (vic.raster === targetRaster && vic.cycleInLine === targetCycle) return;
    vic.clock(1);
  }
  throw new Error(`driveTo timed out at raster=${vic.raster} cycle=${vic.cycleInLine}`);
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

// ── 1: c15 clear with FF ALREADY SET does NOT latch crunch (Bauer 7a) ──
// Rule 7a's gate is on the FF state BEFORE the clear: a c15 clear only
// crunches when it is the write that first sets the FF. With the FF
// already set, no crunch latches. (This is the Coma Light 13 release case.)
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 1;            // FF already SET before the clear
  vic.clock(1);                           // → c15
  vic.write(0x17, 0x00);                  // CPU clears MxYE at c15 phi2
  expect(vic._spriteCrunchPending[0] === 0,
    `rule 7a: c15 clear with FF already set must NOT latch crunch, got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer 7a: c15 clear with FF already set does NOT latch crunch (FF gate)');
}

// ── 2: c16 runs clean MCBASE := MC when FF was set at c15 (no crunch) ──
// Because the c15 clear with FF-set does not latch the crunch, cycle 16
// takes the ordinary advance (MCBASE := MC), not the bit-interleave.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 1;
  vic.spriteMCBase[0] = 0b011010;
  vic.spriteMC[0]     = 0b101100;
  vic.clock(1);
  vic.write(0x17, 0x00);
  vic.clock(1);                           // → c16
  expect(vic.spriteMCBase[0] === 0b101100,
    `c16 clean MCBASE := MC (${0b101100}) when FF was set at c15, got ${vic.spriteMCBase[0]}`);
  ok('Bauer 7a: c16 runs clean MCBASE := MC when the c15 clear was FF-gated');
}

// ── 3: c15 SET (e.g. INC bit) does NOT latch crunch ──────────────────
// Both Bauer and Addendum agree.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x00;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 1;
  vic.clock(1);
  vic.write(0x17, 0x01);                  // SET MxYE
  expect(vic._spriteCrunchPending[0] === 0,
    `setting MxYE at c15 must NOT latch crunch, got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer + Addendum: c15 set bit does not latch crunch (consensus)');
}

// ── 4: c14 clear (one cycle before window) does NOT latch crunch ──────
// Both interpretations agree on the EXACT cycle window.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 200;
  vic.spriteDmaOn[0] = 1;
  driveTo(vic, 0, 14);
  vic.spriteYExpandFF[0] = 1;
  vic.write(0x17, 0x00);                  // c14 — outside window
  expect(vic._spriteCrunchPending[0] === 0,
    `c14 write outside window must NOT latch crunch, got ${vic._spriteCrunchPending[0]}`);
  ok('Bauer + Addendum: c14 outside crunch window — no latch (consensus)');
}

console.log(`\n${testNo} addendum sprite-crunch spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
