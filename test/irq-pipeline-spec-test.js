// IRQ propagation pipeline integration lock-down — asymmetric pipeline:
// VIC raster IRQ: 1-cy delay (sweet spot for raster-IRQ-driven demos)
// CIA1 IRQ:       2-cy delay (matches VICE's measured 2-cycle CIA delay)
// CIA2 NMI:       SYMMETRIC with the IRQ — the CIA2 /NMI edge is latched at phi1
//                 (_cpuNmiEdgeSeen) and presented to the CPU one machine stage
//                 later by _sampleCpuInterrupts, same depth as the IRQ. This is
//                 VICE's old-6526 timing (measured: 1-cycle assert delay,
//                 identical for IRQ and NMI). The earlier SAME-CYCLE rule (_nmiSameCycle, a
//                 Hat $8800 workaround) delivered NMI a cycle EARLY and was WRONG:
//                 it crashed Coma's logo and regressed cia-int-nmi 38→68. Removed
//                 2026-06-26 (Phase 2 of the CIA refactor); see test 3.
//
// This file is NOT a pure chip-spec test. Bauer/Addendum are silent on the
// emulator's chosen CPU-visible interrupt propagation pipeline. The
// assertions below lock the current integration policy because demos are
// sensitive to it, but they should be treated as diagnostics / regression
// guards, not as primary spec proof.
//
// Background:
// - 0-cy uniform (= same-cycle propagation): raster_time_gp's vertical
//   bars flickered, Nine's "9-sprite-in-border" timing was off.
// - 1-cy uniform: improved Nine to "almost perfect", raster_time_gp
//   bars still flicker but better.
// - 2-cy uniform: lost the vertical bars in raster_time_gp.
// - 1-cy VIC + 2-cy CIA + 2-cy NMI: keeps Nine + raster_time_gp gains,
//   approximates VICE for CIA + NMI workflows. Wizball (CIA-timer) still
//   works.
//
// Reference:
//   - VICE (measured): VIC + CIA IRQ integration-layer delays; CIA = 2 cy
//   - Bauer §3.12 (silent on integration-layer cycle propagation)
//   - VIC-Addendum.txt (silent on this)
//
// What this pins (net latency preserved across the 2026 CIA sub-cycle rework:
// the chip-internal ICR data→IR latch now supplies one cycle that used to be
// a machine pipeline stage, and the CIA clocks at phi1):
//   1. VIC IRQ propagates after 1 master cycle (via _cpuVicIrqPending).
//   2. CIA IRQ: in-CIA IR latch (1 clock) + 1 machine stage (_cpuCiaIrqPending
//      → cpu.irqLine).
//   3. NMI: in-CIA latch, presented one machine stage later (edge-sticky) —
//      SAME depth as the IRQ path (symmetric, VICE-measured old-6526 timing).
//   4. Multi-source OR-combination works through the asymmetric pipeline.

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
  m.cpu.clock = () => {};
  m.cpu.atInstructionBoundary = () => true;
  m.cpu.peekNextBusKind = () => 'read';
  m.cpu.nextBusIsWrite = () => false;
  m.cpu.sampledIrq = false;
  m.cpu.irqLine = false;
  m.cpu.nmiLine = false;
  m.drive1541 = null;
  return m;
}

// ── 1: CIA1 raises IRQ → cpu.irqLine high after in-CIA latch + 1 stage ──
{
  const m = makeMachine();
  m.cia1.icrMask = 0x01;
  m.cia1.icrStatus = 0;
  m._runMasterCycle();
  expect(m.cpu.irqLine === false, `before CIA assertion, cpu.irqLine must be low`);
  // Model a timer underflow: set the data bit and arm the IR latch, exactly as
  // cia.clock() does on underflow (data bit immediate, IR latch one clock later).
  m.cia1.icrStatus = 0x01;
  m.cia1._irNextPending = true;
  expect(m.cpu.irqLine === false && m._cpuCiaIrqPending === false,
    `armed but IR latch not yet fired → cpu.irqLine still low`);
  // Cycle 1: phi1 CIA clock fires the IR latch → _cpuCiaIrqPending true (the
  // irq-sample earlier this cycle still saw it low).
  m._runMasterCycle();
  expect(m._cpuCiaIrqPending === true, `in-CIA IR latch fired this cycle`);
  expect(m.cpu.irqLine === false, `1 machine stage not yet applied`);
  // Cycle 2: irq-sample applies the pending flag → cpu.irqLine.
  m._runMasterCycle();
  expect(m.cpu.irqLine === true,
    `CIA IRQ reaches cpu after in-CIA latch + 1 machine stage (net = old 2-cy)`);
  ok('CIA IRQ assertion → cpu.irqLine high (in-CIA latch + 1 machine stage)');
}

// ── 2: VIC raster IRQ → cpu.irqLine high after 1-cy pipeline ───────────
{
  const m = makeMachine();
  m.vic2.irqMask = 0x01;
  m.vic2.irqStatus = 0;
  m._runMasterCycle();
  expect(m.cpu.irqLine === false, `before VIC assertion, cpu.irqLine must be low`);
  m.vic2.irqStatus = 0x01;
  m.vic2.irqStatus |= 0x80;
  m.vic2.irqHandler(true);
  // VIC: 1-stage pipeline. _cpuVicIrqPending is set; next master cycle applies.
  expect(m._cpuVicIrqPending === true, `VIC assertion sets pending flag`);
  m._runMasterCycle();
  expect(m.cpu.irqLine === true,
    `VIC raster IRQ propagates after 1-cy pipeline (constrained by raster_time_gp + Nine)`);
  ok('VIC raster IRQ assertion → cpu.irqLine high after 1-cy pipeline');
}

// ── 3: CIA2 NMI assertion → cpu.nmiLine high ONE cycle later (symmetric w/ IRQ) ─
// NMI is edge-triggered at the 6510 input. A CIA2 /NMI edge raised by phi1's
// cia2.clock is latched in the CIA the SAME cycle (_cpuNmiEdgeSeen) but presented
// to the CPU at the TOP of the NEXT master cycle by _sampleCpuInterrupts — one
// machine stage, IDENTICAL to the IRQ pipeline (test 2). This is the honest
// old-6526 timing: VICE (measured) asserts a timer interrupt one cycle after
// the underflow, the SAME for IRQ and NMI. The former same-cycle presentation (_nmiSameCycle,
// added as a Hat $8800 workaround) delivered the NMI a cycle EARLY — wrong
// direction: it crashed Coma's logo scene (the early NMI landed inside the music
// player's PLA/RTS stack-dispatch → RTI to $001C → JAM) and regressed the TLR
// cia-int-nmi testprog 38→68 misses. Removing it fixes Coma and halves the
// cia-int-nmi miss count. The Hat's true root (the live $DD06 timer-B value it
// reads as a JMP operand) is the Timer-B reload timing, fixed in the CIA timer
// core (validated by the CIA testbench suite).
{
  const m = makeMachine();
  m.cia2.icrMask = 0x01;
  m.cia2.icrStatus = 0;
  m._runMasterCycle();
  expect(m.cpu.nmiLine === false, `before CIA2 assertion, cpu.nmiLine must be low`);
  // Model a timer underflow arming the IR latch (as cia.clock() does).
  m.cia2.icrStatus = 0x01;
  m.cia2._irNextPending = true;
  // Cycle 1: phi1 CIA clock fires the IR latch → NMI edge latched in the CIA
  // (_cpuNmiEdgeSeen / _cpuNmiPending), but NOT yet presented to the CPU.
  m._runMasterCycle();
  expect(m._cpuNmiPending === true, `in-CIA IR latch fired → NMI source asserted`);
  expect(m.cpu.nmiLine === false,
    `NMI edge latched but not presented same-cycle (no early delivery)`);
  // Cycle 2: _sampleCpuInterrupts presents the sticky edge → cpu.nmiLine high,
  // one machine stage later — same depth as the IRQ pipeline.
  m._runMasterCycle();
  expect(m.cpu.nmiLine === true,
    `CIA2 NMI reaches cpu one cycle later (machine stage, symmetric with IRQ)`);
  ok('CIA2 NMI assertion → cpu.nmiLine high one cycle later (symmetric with IRQ)');
}

// ── 3b: VIC IRQ assertion during 'cpu' phase carries a one-cycle late tag ──
// Bauer §3.12: natural raster IRQ fires in 'vic' phase (cycle 1 access) and
// is NOT late-tagged. CPU writes to $d011/$d012/$d01a/$d019 that newly
// assert the IRQ run in 'cpu' phase — those carry the late tag because
// the CPU has already passed its phi2 sample for the current cycle.
{
  const m = makeMachine();
  m.vic2.irqStatus = 0x81;
  m.vic2.irqMask = 0x01;
  m._masterPhase = 'cpu';
  m.vic2.irqHandler(true);
  expect(m._cpuVicIrqPending === true, `VIC assertion sets pending flag`);
  expect(m._cpuVicIrqPendingLate === true,
    `'cpu' phase VIC assertion is tagged late for its first CPU-visible cycle`);

  m._runMasterCycle();
  expect(m.cpu.irqLine === true, `VIC IRQ propagated to CPU`);
  expect(m.cpu.irqLineLate === true,
    `first CPU-visible cycle carries late tag`);

  m._runMasterCycle();
  expect(m.cpu.irqLine === true, `VIC IRQ remains asserted while source pending`);
  expect(m.cpu.irqLineLate === false,
    `late tag ages out after the first CPU-visible cycle`);

  ok(`VIC IRQ assertion in 'cpu' phase propagates with a one-cycle late tag`);
}

// ── 4: CIA de-assertion propagates after 1 machine stage ───────────────
{
  const m = makeMachine();
  m.cia1.icrMask = 0x01;
  m.cia1.icrStatus = 0x01;
  m.cia1._irLatch = true;            // IR latched (asserted)
  m._updateC64Irq();
  expect(m.cpu.irqLine === true, `precondition: cpu.irqLine high (via sync force-update)`);
  // Read $DC0D clears the data + IR latch atomically (clean ack: IR was set).
  m.cia1.read(0x0D);
  expect(m._cpuCiaIrqPending === false, `CIA IRQ de-assertion sets pending flag low`);
  // One machine stage: next irq-sample applies the low pending → cpu.irqLine.
  m._runMasterCycle();
  expect(m.cpu.irqLine === false,
    `CIA IRQ de-assertion propagates after 1 machine stage`);
  ok('CIA IRQ de-assertion → cpu.irqLine low after 1 machine stage');
}

// ── 5: CIA + VIC sources OR-combine through asymmetric pipeline ─────────
{
  const m = makeMachine();
  m.cia1.icrMask = 0x01;
  m.vic2.irqMask = 0x01;
  m.cia1.icrStatus = 0x81;
  m.vic2.irqStatus = 0x81;
  m._updateC64Irq();
  expect(m.cpu.irqLine === true, `OR-combined IRQ propagates (sync force-update)`);
  m.cia1.icrStatus = 0;
  m._updateC64Irq();
  expect(m.cpu.irqLine === true,
    `clearing one source while the other still asserts keeps cpu.irqLine high`);
  m.vic2.irqStatus = 0;
  m._updateC64Irq();
  expect(m.cpu.irqLine === false,
    `clearing both sources clears cpu.irqLine`);
  ok('CIA + VIC IRQs are OR-combined into the single CPU pin (asymmetric pipeline)');
}

if (testsFailing > 0) {
  console.log(`\n${testsFailing} of ${testNo} tests FAILED`);
  process.exit(1);
}
console.log(`\nAll ${testNo} tests passed`);
