// CIA timer → interrupt delay relationship (IRQ vs NMI).
//
// C64 wiring: CIA1's interrupt output → CPU IRQ, CIA2's → CPU NMI. Both CIAs
// are the same MOS 6526, but the 6510 inputs differ: IRQ is maskable and
// level-sensitive; NMI is edge-triggered.
//
// Spec boundary: Bauer §2.2 says IRQ starts at least two clock cycles later at
// the next instruction and is only recognized while RDY is high. Bauer §3.12
// specifies VIC IRQ latching/state sensitivity. Neither Bauer nor the VIC-II
// Addendum defines a machine-level CIA2→NMI compensation stage, so this file
// pins the C64 integration behavior observed by VICE and by CIA2-NMI timing
// code that executes the live $DD04-$DD06 timer registers as opcodes. The
// exact one-stage machine pipeline is tested in irq-pipeline-spec-test; this
// timer-driven test observes whole instruction-boundary acceptance, where the
// two-cycle NOP carpet can quantize a one-cycle pin difference to a 0- or
// 2-cycle handler-accept difference.
//
// Corrected model (2026-06): the CPU samples the NMI edge one cycle before
// acting on it (cpu.sampledNmiEdge), symmetric with IRQ's sampledIrq. With the
// CIA2→NMI machine presentation stage already symmetric (f63090e), NMI and IRQ
// now accept on the SAME instruction boundary — matching VICE ("CIA delivers
// IRQ and NMI identically"). This test pins that SYMMETRY (nmi == irq); the old
// assertion that NMI is one edge EARLIER encoded the pre-sampling asymmetry that
// landed The Hat's stable-NMI one cycle off in its $8c1a dispatch.
// Regression guard: do NOT remove the NMI sampling (cpu.sampledNmiEdge) — that
// reintroduces the asymmetry (NMI one cycle too early).

import { C64Machine } from '../src/machine.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function makeMachine() {
  const m = new C64Machine();
  m.reset();
  m.mem.ram.fill(0xEA);                 // NOP carpet everywhere
  m.mem.write(0x0001, 0x35);            // RAM + I/O, KERNAL/BASIC out
  m.mem.ram[0xFFFE] = 0x00; m.mem.ram[0xFFFF] = 0x90;  // IRQ vector → $9000
  m.mem.ram[0xFFFA] = 0x00; m.mem.ram[0xFFFB] = 0xA0;  // NMI vector → $A000
  for (let i = 0; i < 16; i++) { m.mem.ram[0x9000 + i] = 0xEA; m.mem.ram[0xA000 + i] = 0xEA; }
  return m;
}

// Park the CPU at an instruction boundary on a known, non-bad-line raster so
// no DMA/BA stall perturbs the count.
function driveAndPark(m, raster = 50, cy = 1) {
  let safety = 60000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cy)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
}

// Start CIA timer A (continuous) with `timerVal` and the timer-A interrupt
// enabled, then count master cycles until the CPU reaches its interrupt
// handler. CIA1 → IRQ ($9000), CIA2 → NMI ($A000).
function measureLatency(useNmi, timerVal) {
  const m = makeMachine();
  driveAndPark(m, 50, 1);
  const cia = useNmi ? m.cia2 : m.cia1;
  if (!useNmi) m.cpu.I = 0;             // IRQ needs I clear; NMI ignores it

  cia.write(0x04, timerVal & 0xFF);     // timer A lo
  cia.write(0x05, 0x00);                // timer A hi
  cia.write(0x0D, 0x81);                // ICR: enable timer-A interrupt
  cia.write(0x0E, 0x11);                // CRA: force-load + start (continuous)

  let acceptedAt = -1;
  let cy = 0, safety = 600;
  m.cpu.onInterruptAccept = (kind) => {
    if ((useNmi && kind === 'nmi') || (!useNmi && kind === 'irq')) acceptedAt = cy;
  };
  while (--safety) {
    C64Machine.prototype._runMasterCycle.call(m);
    cy++;
    if (acceptedAt >= 0) return acceptedAt;
  }
  return -1;
}

// ── 1: NMI and IRQ accept on the SAME instruction boundary (symmetric).
{
  const vals = [20, 21, 22, 23, 24];
  let allEqual = true;
  const rows = [];
  for (const v of vals) {
    const irq = measureLatency(false, v);
    const nmi = measureLatency(true, v);
    rows.push(`timer=${v}: IRQ=${irq} NMI=${nmi}`);
    expect(irq > 0 && nmi > 0, `both handlers reached for timer=${v} (IRQ=${irq}, NMI=${nmi})`);
    if (nmi !== irq) allEqual = false;
    expect(nmi === irq,
      `CIA2/NMI accepts on the SAME boundary as CIA1/IRQ (symmetric, VICE: identical delivery) for timer=${v}: IRQ=${irq} NMI=${nmi} (diff ${nmi - irq})`);
  }
  if (!allEqual) for (const r of rows) console.log(`     · ${r}`);
  ok('C64 integration: CIA2 NMI and CIA1 IRQ accept on the same instruction boundary (symmetric)');
}

// ── 2: the latency monotonically tracks the timer value (sanity: a larger
// reload means a proportionally later interrupt — same for both lines).
{
  const a = measureLatency(false, 20);
  const b = measureLatency(false, 24);
  const an = measureLatency(true, 20);
  const bn = measureLatency(true, 24);
  expect(b > a, `IRQ latency grows with timer reload: timer20=${a} timer24=${b}`);
  expect(bn > an, `NMI latency grows with timer reload: timer20=${an} timer24=${bn}`);
  expect((b - a) === (bn - an),
    `IRQ and NMI latency grow by the same step: IRQΔ=${b - a} NMIΔ=${bn - an}`);
  ok('CIA timer reload shifts IRQ and NMI vector point identically');
}

console.log(`\n${testsFailing === 0 ? 'PASS' : 'FAIL'}: ${testNo - testsFailing}/${testNo} tests passed`);
if (testsFailing > 0) process.exit(1);
