// Master-cycle ordering edge cases — fills SPEC-ALIGNED gaps in existing
// coverage for the _runMasterCycle() phase boundaries.
//
// Existing coverage (NOT duplicated here):
//   - VIC IRQ → CPU pipeline (irq-pipeline-spec-test.js tests 2, 4)
//   - CIA IRQ → CPU pipeline 2cy (irq-pipeline-spec-test.js test 1)
//   - CIA force-load + start delay (cia-force-load-edge-spec-test.js)
//   - CIA timer A underflow → ICR → IRQ line (cia1-timer-irq-integration-spec)
//   - BA-low blocks reads, allows writes; AEC-low blocks writes
//     (ba-aec-matrix-spec, master-cycle-spec)
//
// SPEC-aligned gap-fill coverage added in this file:
//   1. CIA Timer A in PHI2 mode ticks every master cycle (MOS 6526).
//   2. BA-low blocks read cycles per Bauer §3.5 strict (symmetric model).
//   3. BA-low blocks internal cycles per Bauer §3.5 + 6510 every-cycle
//      bus access.
//   4. _runMasterCycle component order — architectural lock that
//      preserves spec sequencing for IRQ/CIA/VIC interactions.
//
// NOT included (spec-ambiguous, would be impl-locks):
//   - CIA STOP write timing (MOS 6526 doesn't unambiguously specify
//     same-cycle vs next-cycle effect of CRA writes).
//
// BA stall is the single Bauer §3.5 symmetric model (BA low stalls any
// non-write CPU cycle on the same cycle); the old runtime model selector
// was removed.

import { C64Machine } from '../src/machine.js';

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

function makeMachine() {
  const m = new C64Machine();
  m.reset();
  return m;
}

// ── 1: CIA Timer A in PHI2 mode ticks every master cycle.
//
// Per MOS 6526 datasheet: "Timer is decremented at every phi2 rising
// edge if the START bit is set." Verify 1 tick per master cycle when
// no other state changes interfere.
{
  const m = makeMachine();
  m.cia1.icrMask = 0;
  m.cia1.icrStatus = 0;
  m.cia1.timerA = 5;
  m.cia1.latchA = 0xFFFF;
  m.cia1.cra = 0x01;

  m.cpu.clock = () => {};
  m.cpu.peekNextBusKind = () => 'read';
  m.cpu.nextBusIsWrite = () => false;
  m.cpu.atInstructionBoundary = () => false;
  m.vic2.clock = () => {};
  m.vic2.phi2 = () => {};
  m.vic2.isBaLow = () => false;
  m.vic2.isBadLineBaLow = () => false;
  m.vic2.isSpriteBaLow = () => false;
  m.vic2.isAecLowPhi2 = () => false;
  m.drive1541 = null;

  m._runMasterCycle();
  expect(m.cia1.timerA === 4, `1st cycle: 5→4; got ${m.cia1.timerA}`);
  m._runMasterCycle();
  expect(m.cia1.timerA === 3, `2nd cycle: 4→3; got ${m.cia1.timerA}`);
  m._runMasterCycle();
  expect(m.cia1.timerA === 2, `3rd cycle: 3→2; got ${m.cia1.timerA}`);
  ok(`CIA Timer A in PHI2 mode: 1 tick per master cycle (MOS 6526)`);
}

// ── 2: BA-low blocks read cycles per Bauer §3.5 strict.
//
// Bauer §3.5: "BA-low halts a read access." Canonical (symmetric) BA
// model implements this. Reading is blocked while BA is low.
{
  const m = makeMachine();
  let cpuClockCount = 0;
  m.cpu.clock = () => cpuClockCount++;
  m.cpu.peekNextBusKind = () => 'read';
  m.cpu.nextBusIsWrite = () => false;
  m.cpu.atInstructionBoundary = () => false;
  m.vic2.clock = () => {};
  m.vic2.phi2 = () => {};
  m.vic2.isBaLow = () => true;
  m.vic2.isBadLineBaLow = () => true;
  m.vic2.isSpriteBaLow = () => false;
  m.vic2.isAecLowPhi2 = () => false;
  m.drive1541 = null;

  m._runMasterCycle();

  expect(cpuClockCount === 0,
    `BA-low blocks read; cpuClockCount=${cpuClockCount}`);
  ok(`BA-low blocks read cycles per Bauer §3.5 strict`);
}

// ── 3: BA-low blocks internal cycles per Bauer §3.5 + 6510 every-cycle.
//
// Bauer §3.5: the 6510 does a real bus access EVERY cycle, including
// internal/dummy reads. So RDY-low (= BA-low) stalls internal cycles
// too. The canonical symmetric model implements this.
{
  const m = makeMachine();
  let cpuClockCount = 0;
  m.cpu.clock = () => cpuClockCount++;
  m.cpu.peekNextBusKind = () => 'internal';
  m.cpu.nextBusIsWrite = () => false;
  m.cpu.atInstructionBoundary = () => false;
  m.vic2.clock = () => {};
  m.vic2.phi2 = () => {};
  m.vic2.isBaLow = () => true;
  m.vic2.isBadLineBaLow = () => true;
  m.vic2.isSpriteBaLow = () => false;
  m.vic2.isAecLowPhi2 = () => false;
  m.drive1541 = null;

  m._runMasterCycle();

  expect(cpuClockCount === 0,
    `BA-low blocks internal cycle; cpuClockCount=${cpuClockCount}`);
  ok(`BA-low blocks internal cycles per Bauer §3.5 + 6510 every-cycle bus`);
}

// ── 4: _runMasterCycle component order — preserves spec sequencing.
//
// The canonical phase order: IRQ-sample → VIC → CIA → CPU → VIC-phi2 →
// datasette. This order EMBODIES the spec-derived sequencing:
//   - VIC phi1 logic runs BEFORE CPU phi2 (per Bauer §3.4: VIC owns
//     phi1 for c-access/g-access fetches)
//   - CIA timer counting + underflow + IR-latch run at phi1, BEFORE the
//     CPU's phi2 — so a CPU $DC0D/$DC04 read this cycle sees this cycle's
//     underflow (the MOS 6526 interrupt-acknowledge bug). The CIA→CPU IRQ
//     delay is preserved because IRQ-sample consumed the prior cycle's
//     pending before this CIA clock sets the new state.
//   - CPU writes at phi2 are visible to VIC's phi2 hook (= post-write
//     register state used for VIC sprite-crunch etc.) and to NEXT cycle's
//     CIA clock (CRA force-load latency lives in _craStartPending=2).
//
// Reordering would silently change observable behavior. Lock here.
{
  const m = makeMachine();
  const order = [];

  m.cpu.clock = () => order.push('cpu');
  m.cpu.peekNextBusKind = () => 'read';
  m.cpu.nextBusIsWrite = () => false;
  m.cpu.atInstructionBoundary = () => false;
  m.vic2.clock = () => order.push('vic');
  m.vic2.phi2 = () => order.push('vic-phi2');
  m.vic2.isBaLow = () => false;
  m.vic2.isBadLineBaLow = () => false;
  m.vic2.isSpriteBaLow = () => false;
  m.vic2.isAecLowPhi2 = () => false;
  m.cia1.clock = () => order.push('cia1');
  m.cia2.clock = () => order.push('cia2');
  m.datasette.clock = () => order.push('datasette');
  m.datasette.motorOn = true;   // _runMasterCycle gates datasette.clock on motorOn
                                // (it early-returns when the motor is off, so the
                                // call is skipped as a no-op); enable it here so this
                                // architectural lock still observes the datasette
                                // phase in canonical order.
  m.drive1541 = null;

  const origSample = m._sampleCpuInterrupts.bind(m);
  m._sampleCpuInterrupts = () => { order.push('irq-sample'); origSample(); };

  m._runMasterCycle();

  expect(JSON.stringify(order) === JSON.stringify([
    'irq-sample', 'vic', 'cia1', 'cia2', 'cpu', 'vic-phi2', 'datasette',
  ]), `expected canonical order; got: ${JSON.stringify(order)}`);
  ok(`_runMasterCycle component order preserves spec sequencing (architectural lock)`);
}

console.log(`\n${testNo} master-cycle spec-alignment tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
