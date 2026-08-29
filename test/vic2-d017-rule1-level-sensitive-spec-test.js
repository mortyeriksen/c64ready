// Bauer §3.8.1 rule 1 level-sensitivity spec test.
//
// Spec quote (https://www.cebix.net/VIC-Article.txt):
//   "The advance line flip-flop is set as long as the corresponding
//    MxYE bit in register $d017 is cleared."
//
// "as long as" = level-sensitive: while MxYE=0, the FF is continuously
// forced to 1. Not just at cycle 56 phi1.
//
// Our current impl (vic2.js _spriteSequencerCycle56) runs the force
// inside the cycle-56 phi1 evaluation only, plus the phi2() reconcile
// for same-cycle CPU writes. Writes at any OTHER cycle that clear MxYE
// should still latch FF=1 immediately, but our impl waits until next
// line's c56.
//
// FppScroller's IRQ handler does `DEC $D017` mid-iteration where the
// write-NEW value (with one bit cleared = MxYE off for one sprite) can
// land at any cycle in 0..62 depending on slide alignment. If real
// silicon's level-sensitive rule 1 forces FF=1 immediately and ours
// waits for c56, the FF state diverges across many iterations — which
// then propagates to MC counter advancement, sprite display state,
// BA-low duration, and ultimately IRQ-chain timing.

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

// ── 1: Clearing MxYE mid-line must immediately force FF to 1 ─────────
// Setup: sprite 0 with MxYE=1, DMA on, FF=1. Drive past line 0's c56
// toggle → FF flips 1→0. Then drive to c30 of line 1 (no toggles in
// 0..30). FF=0 at c30. CPU clears MxYE at c30 phi2. Per level-sensitive
// rule 1, FF must be forced to 1 the moment MxYE goes 0 — observable
// at c31 phi1.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;                // sprite 0 enabled
  vic.regs[0x17] = 0x01;                // MxYE=1
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 1;            // start at 1
  driveTo(vic, 1, 30);                   // line 0 c56 toggled FF 1→0
  expect(vic.spriteYExpandFF[0] === 0, `pre-write: FF=0 (post-toggle from line 0 c56)`);
  vic.write(0x17, 0x00);                 // clear MxYE
  vic.clock(1);                          // advance to c31 phi1
  expect(vic.spriteYExpandFF[0] === 1,
    `Bauer §3.8.1 rule 1 (level-sensitive): MxYE=0 → FF must be forced to 1 immediately, got ${vic.spriteYExpandFF[0]}`);
  ok('Bauer §3.8.1 rule 1: clearing MxYE mid-line forces FF=1 (level-sensitive)');
}

// ── 2: Setting MxYE mid-line does NOT change FF (rule 1 only forces) ──
// Rule 1 only acts when MxYE goes from 1 to 0 (or stays 0). Setting
// MxYE 0→1 doesn't touch the FF — it merely re-enables the cycle-56
// toggle for the next opportunity.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;                 // MxYE=0
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 1;            // forced by rule 1
  driveTo(vic, 1, 30);
  vic.write(0x17, 0x01);                 // set MxYE
  vic.clock(1);
  expect(vic.spriteYExpandFF[0] === 1,
    `setting MxYE 0→1 mid-line must NOT toggle FF (only rule 3 at c56 toggles), got ${vic.spriteYExpandFF[0]}`);
  ok('Bauer §3.8.1 rule 1: setting MxYE mid-line is no-op for FF');
}

// ── 3: MxYE=0 sustained — FF stays 1 across many cycles ─────────────
// The "as long as" clause means FF is continuously forced. Even if a
// stale FF=0 was somehow latched, it must be cleared the moment we
// observe MxYE=0 — and stay 1 across subsequent cycles.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;                 // MxYE=0
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 0;            // synthetic stale FF=0
  driveTo(vic, 1, 5);
  // First clock cycle should observe MxYE=0 and force FF=1.
  vic.clock(1);
  expect(vic.spriteYExpandFF[0] === 1,
    `MxYE=0 is level-sensitive: stale FF=0 must be cleared at next clock, got ${vic.spriteYExpandFF[0]}`);
  // Continue clocking — FF must stay 1.
  for (let i = 0; i < 30; i++) vic.clock(1);
  expect(vic.spriteYExpandFF[0] === 1,
    `MxYE=0 sustained: FF must stay 1 across 30 cycles, got ${vic.spriteYExpandFF[0]}`);
  ok('Bauer §3.8.1 rule 1: MxYE=0 forces FF=1 continuously (not just at c56)');
}

// ── 4: Cycle-56 toggle gating still requires MxYE=1 at c56 phi1 ──────
// Rule 3 (c56 toggle) is gated by MxYE=1. Confirm rule 1 doesn't bypass
// rule 3 — i.e., when MxYE=1 at c56 phi1, the toggle still fires
// regardless of any earlier mid-line MxYE clears.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;                 // start MxYE=0
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 1;            // initially 1 (forced)
  driveTo(vic, 0, 30);
  vic.write(0x17, 0x01);                 // set MxYE before c56
  driveTo(vic, 0, 57);                   // past c56
  expect(vic.spriteYExpandFF[0] === 0,
    `c56 toggle with MxYE=1 (set mid-line): FF must toggle 1→0, got ${vic.spriteYExpandFF[0]}`);
  ok('Bauer §3.8.1 rule 3: c56 toggle still fires for mid-line MxYE 0→1');
}

console.log(`\n${testNo} D017 rule 1 level-sensitive spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
