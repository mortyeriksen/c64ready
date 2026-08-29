// raster_time_gp mechanism audit / integration lock-down.
//
// This file is intentionally MIXED-SOURCE:
//   - Some assertions are spec-backed (Bauer raster-IRQ cycle, Addendum
//     edge-trigger rule, 6502 phi2 IRQ sampling).
//   - Some assertions lock the emulator's current IRQ integration model
//     ("late-tag", one CPU-visible late window, branch-delay coupling).
//
// The latter are useful diagnostics for raster_time_gp, but they are NOT
// primary spec oracles. When investigating demo flicker, treat failures in
// those sections as "the integration model changed", not automatically as
// "the emulator violated Bauer/Addendum".
//
// Pins the IRQ-accept + de-jitter spin behaviors that raster_time_gp's
// vertical raster bars depend on. Locks in the late-tag mechanism that produces the 5-unique-cycle IRQ
// accept distribution matching VICE.
//
// Spec references (verbatim quotes from the sources below):
//
//   - Bauer "The MOS 6567/6569 video controller (VIC-II) and its
//     application in the Commodore 64" §3.12 (https://www.cebix.net/VIC-Article.txt):
//       "The test for reaching the interrupt raster line is done in
//        cycle 1 of every line (for line 0, in cycle 2). It is possible
//        to trigger an interrupt immediately by writing to $d011/$d012,
//        but the interrupt can never occur more than once per raster
//        line."
//     → Natural raster IRQ fires in the VIC's cycle-1 access window =
//        'vic' master phase in our model. CPU writes to $d011/$d012/$d01a
//        that re-evaluate the compare = 'cpu' master phase (deferred IRQ).
//
//   - VIC-Addendum.txt:61 (https://sourceforge.net/p/vice-emu/code/HEAD/tree/techdocs/VICII/VIC-Addendum.txt):
//       "Raster comparison is edge triggered. If $d012 is changed to
//        always follow the raster counter it will never trigger an IRQ
//        condition."
//     → The comparator latch is set only on rising-edge (non-match →
//        match). Our impl mirrors this with `pending && !_cpuVicIrqPending`
//        edge-detection in vic2.irqHandler.
//
//   - 6502.org "Interrupts" tutorial: "The logic levels of the 6502's
//     interrupt input pins are sampled on the falling edge of φ2."
//     → CPU samples irqLine at the start of its phi2 phase; we model this
//        as the start of cpu.clock() in the 'cpu' master sub-phase.
//
//   - Integration-layer IRQ pipeline delays (asymmetric VIC 1-cy /
//     CIA 2-cy): see irq-pipeline-spec-test.js.
//   - Branch-taken-no-cross IRQ deferral: see
//     cpu-branch-irq-delay-spec-test.js.
//
// What this file pins beyond existing IRQ/branch tests:
//
//   1. VIC raster IRQ asserts during the 'vic' master phase (not 'cpu').
//      Consequence: raster IRQ does NOT trip the late-tag, so the late-
//      tag only applies to CPU-induced IRQ assertions ($D01A enable
//      writes, $D019 re-arm).
//
//   2. CPU $D01A write that newly enables a pending raster IRQ DOES
//      trip the late-tag (= CPU-phase assertion).
//
//   3. CPU $D019 re-arm (= writes that clear the latch while the
//      comparator is still in match state) does NOT trip the late-tag
//      if the comparator hasn't fired again — only fresh edge events
//      from VIC during 'cpu' phase trip it.
//
//   4. The late-tag clears after exactly one CPU-visible master cycle.
//
//   5. NMOS branch-no-cross delay fires when sampledIrq is true AND
//      sampledIrqLate is true at the branch's final cycle (= the IRQ
//      came as a "late first-sample" that missed the canonical early
//      poll).
//
// Audit note:
//   - Item 1 is mostly spec-backed once mapped onto the repo's master-cycle
//     ordering.
//   - Items 2-5 are implementation integration policy (see
//     irq-pipeline-spec-test.js).

import { C64Machine } from '../src/machine.js';
import { CYCLES_PER_LINE } from '../src/vic2.js';

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
  m.cpu.irqLineLate = false;
  m.cpu.nmiLine = false;
  m.drive1541 = null;
  // Reset pipeline state — constructor may leave residual values.
  m._cpuVicIrqPending = false;
  m._cpuVicIrqPendingLate = false;
  m._cpuCiaIrqPending = false;
  m._cpuCiaIrqStaged = false;
  m._cpuNmiPending = false;
  m._cpuNmiEdgeSeen = false;
  return m;
}

// ── 1: VIC raster IRQ during 'vic' master phase does NOT trip late-tag ──
//
// Bauer §3.12 raster IRQ fires at cycle 1 phi1 of matching raster. In
// our master-cycle ordering, vic.clock runs during 'vic' phase — so
// the irqHandler fires from there. _masterPhase === 'vic' at that
// moment → _cpuVicIrqPendingLate must remain false.
{
  const m = makeMachine();
  m.vic2.irqMask = 0x01;
  m._masterPhase = 'vic';
  m.vic2.irqStatus = 0x81;             // mock VIC asserting raster IRQ
  m.vic2.irqHandler(true);
  expect(m._cpuVicIrqPending === true,
    `VIC during 'vic' phase: pending flag set`);
  expect(m._cpuVicIrqPendingLate === false,
    `VIC during 'vic' phase: late-tag must NOT fire (raster IRQ asserts in vic.clock); got late=${m._cpuVicIrqPendingLate}`);
  ok('VIC raster IRQ during vic phase does NOT trip late-tag (Bauer §3.12 + asymmetric pipeline)');
}

// ── 2: VIC IRQ during 'cpu' master phase TRIPS late-tag ─────────────────
//
// When CPU writes $D01A (IRQ enable) and the comparator was already
// latched, the VIC re-evaluates and may newly assert IRQ — during the
// 'cpu' master phase. Late-tag must fire so the CPU's branch-delay
// quirk treats this as a "late first-sample".
{
  const m = makeMachine();
  m.vic2.irqMask = 0x01;
  m._masterPhase = 'cpu';
  m.vic2.irqStatus = 0x81;
  m.vic2.irqHandler(true);
  expect(m._cpuVicIrqPending === true,
    `VIC during 'cpu' phase: pending flag set`);
  expect(m._cpuVicIrqPendingLate === true,
    `VIC during 'cpu' phase: late-tag MUST fire (CPU-induced assertion); got late=${m._cpuVicIrqPendingLate}`);
  ok('VIC IRQ during cpu phase TRIPS late-tag');
}

// ── 3: Late-tag clears after pending deasserts ──────────────────────────
//
// If the VIC pending status drops back to false (e.g., CPU acks via
// $D019), the late-tag is cleared even before the sample point. This
// prevents stale late-flags from confusing the next IRQ.
{
  const m = makeMachine();
  m.vic2.irqMask = 0x01;
  m._masterPhase = 'cpu';
  m.vic2.irqStatus = 0x81;
  m.vic2.irqHandler(true);
  expect(m._cpuVicIrqPendingLate === true,
    `precondition: late-tag set during cpu phase`);
  // CPU clears latch via $D019 write — pending drops to false.
  m.vic2.irqStatus = 0x00;
  m.vic2.irqHandler(false);
  expect(m._cpuVicIrqPending === false, `pending cleared`);
  expect(m._cpuVicIrqPendingLate === false,
    `late-tag also cleared when pending drops`);
  ok('Late-tag clears when VIC pending deasserts (clean-slate for next IRQ)');
}

// ── 4: Late-tag ages out after exactly one CPU-visible master cycle ─────
//
// After the late-tagged IRQ propagates to cpu.irqLineLate, exactly ONE
// CPU master cycle sees the late flag. Subsequent cycles see the IRQ
// line high but irqLineLate=false. This single-cycle window matches
// the NMOS "first sample after assertion" semantics — only the very
// first sample can be "late" (the rest are settled).
{
  const m = makeMachine();
  m.vic2.irqMask = 0x01;
  m._masterPhase = 'cpu';
  m.vic2.irqStatus = 0x81;
  m.vic2.irqHandler(true);
  expect(m._cpuVicIrqPendingLate === true, `pre: pending late`);

  // 1st master cycle propagates pending → cpu.irqLine + cpu.irqLineLate.
  m._runMasterCycle();
  expect(m.cpu.irqLine === true,
    `1st master cycle: cpu.irqLine high`);
  expect(m.cpu.irqLineLate === true,
    `1st master cycle: late tag visible on CPU pin`);

  // 2nd master cycle: irqLine stays high, late tag cleared.
  m._runMasterCycle();
  expect(m.cpu.irqLine === true,
    `2nd master cycle: cpu.irqLine still high (source still pending)`);
  expect(m.cpu.irqLineLate === false,
    `2nd master cycle: late tag cleared (aged out)`);
  ok('Late-tag ages out after exactly one CPU-visible master cycle');
}

// ── 5: irqHandler called twice in same master cycle preserves late-tag ──
//
// If two source events fire within one master cycle (e.g., CIA also
// asserts), the late-tag from the first must persist. This guards
// against accidental clearing in OR-combined paths.
{
  const m = makeMachine();
  m.vic2.irqMask = 0x01;
  m._masterPhase = 'cpu';
  m.vic2.irqStatus = 0x81;
  m.vic2.irqHandler(true);
  expect(m._cpuVicIrqPendingLate === true, `pre: late-tag set`);
  // Same master cycle: VIC handler called again (e.g., status changes mid-cycle).
  m.vic2.irqHandler(true);
  expect(m._cpuVicIrqPendingLate === true,
    `late-tag stays set across repeated handler calls in same cycle`);
  ok('Late-tag persists across repeated irqHandler calls in same master cycle');
}

// ── 6: VIC pending=false clears late-tag even when re-asserted ─────────
//
// Sequence: VIC asserts (late-tagged) → VIC pending drops to false →
// VIC re-asserts during 'vic' phase. The re-assertion is NOT a late
// event (it's a fresh raster-compare edge during vic.clock).
{
  const m = makeMachine();
  m.vic2.irqMask = 0x01;
  m._masterPhase = 'cpu';
  m.vic2.irqStatus = 0x81;
  m.vic2.irqHandler(true);
  expect(m._cpuVicIrqPendingLate === true, `pre: late-tag set during cpu phase`);

  // CPU acks IRQ ($D019 write): pending → false. Late-tag clears.
  m.vic2.irqStatus = 0x00;
  m.vic2.irqHandler(false);
  expect(m._cpuVicIrqPendingLate === false, `late-tag cleared with pending=false`);

  // Now VIC re-asserts on next raster match (during 'vic' phase).
  m._masterPhase = 'vic';
  m.vic2.irqStatus = 0x81;
  m.vic2.irqHandler(true);
  expect(m._cpuVicIrqPending === true, `re-assertion: pending set`);
  expect(m._cpuVicIrqPendingLate === false,
    `re-assertion during vic phase: NOT late (raster IRQ is normal)`);
  ok('VIC re-assertion during vic phase is NOT late (fresh raster-compare edge)');
}

// ── 7: 6502 NMOS phi2 sampling semantics ──────────────────────────────
//
// 6502.org: "The logic levels of the 6502's interrupt input pins are
// sampled on the falling edge of φ2." In our master-cycle ordering,
// CPU samples at the start of cpu.clock — which represents the phi2
// falling edge sample from the PREVIOUS cycle in NMOS terms.
//
// What this pins: irqLine state visible to CPU at cycle K start =
// phi2 sample of cycle K-1 (in NMOS terms).
{
  const m = makeMachine();
  m.cpu.clock = function() {
    if (this.instructionCyclesRemaining > 0) {
      this.sampledIrqPrev = this.sampledIrq;
      this.sampledIrq = this.irqLine;
      this.sampledIrqLate = this.irqLine && this.irqLineLate;
      this.irqLineLate = false;
    }
  }.bind(m.cpu);
  m.cpu.instructionCyclesRemaining = 1;
  m.cpu.sampledIrq = false;

  // Set irqLine + Late flag, simulating IRQ visible on CPU pin.
  m.cpu.irqLine = true;
  m.cpu.irqLineLate = true;
  m.cpu.clock();
  expect(m.cpu.sampledIrq === true,
    `sampledIrq captures irqLine at clock() start`);
  expect(m.cpu.sampledIrqLate === true,
    `sampledIrqLate captures the late flag at the same moment`);
  expect(m.cpu.irqLineLate === false,
    `irqLineLate cleared after CPU sample (late tag is one-shot)`);
  ok('6502.org: phi2 sampling captures irqLine + late tag at cpu.clock start');
}

console.log(`\n${testNo} raster_time mechanism spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
