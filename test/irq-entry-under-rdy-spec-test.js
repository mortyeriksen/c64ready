// IRQ and NMI entry under VIC BA-low (RDY-low) integration spec test.
//
// Bauer §3.13 + §3.6.1: NMOS 6510 interrupt entry takes 7 cycles. While RDY is
// low (= BA-low for a read cycle), the entry sequence stalls on read
// micro-ops (cycles 1, 2, 6, 7) but writes (cycles 3, 4, 5 — push P/PCH/PCL)
// proceed. The total master-cycle count from IRQ recognition to first
// handler opcode is therefore:
//   T_entry = 7 + (BA-low stall cycles overlapping reads in entry)
//
// Cycle-counted handler demos (FppScroller, OrbitUntold, nine.prg) all
// pre-compute the cycle at which the handler will execute its first
// register write based on this exact accounting. A 1-cycle drift in the
// BA model — at either falling or rising edge, for either bad-line or
// sprite-BA — pushes every handler's exit point off by the same amount,
// accumulating per BA window crossed across the demo's IRQ chain.
//
// Audit gaps:
//   A2: IRQ entry under RDY-low bad-line BA
//   A3: IRQ entry under sprite-BA (asymmetric 1-cy delay)

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

function makeMachine(displayActive = false) {
  const m = new C64Machine();
  m.reset();
  m.mem.ram.fill(0xEA);
  m.mem.ram[0xFFFE] = 0x00;
  m.mem.ram[0xFFFF] = 0x90;              // IRQ vector → $9000
  m.mem.ram[0xFFFA] = 0x00;
  m.mem.ram[0xFFFB] = 0xA0;              // NMI vector → $A000
  // ISR runway: NOP carpet for cycles AFTER entry.
  for (let i = 0; i < 64; i++) { m.mem.ram[0x9000 + i] = 0xEA; m.mem.ram[0xA000 + i] = 0xEA; }
  m.cpu.pc = 0x1000;
  m.cpu.I = 0;
  m.cpu.sampledIrq = false;
  m.cpu.nmiEdge = false;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  if (displayActive) {
    m.vic2.regs[0x11] = 0x1B;
    m.vic2.displayEnabled = true;
  }
  return m;
}

function driveTo(m, raster, cycle) {
  let safety = 200000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cycle)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  if (safety <= 0) throw new Error(`driveTo timed out at L${m.vic2.raster}.c${m.vic2.cycleInLine}`);
}

// Drive master cycles until cpu.pc === target, return master-cycle count.
function cyclesUntilPc(m, target, budget = 200) {
  for (let i = 0; i < budget; i++) {
    if (m.cpu.pc === target) return i;
    C64Machine.prototype._runMasterCycle.call(m);
  }
  return -1;                              // not reached
}

// The same four cases for both interrupt pins: the maskable IRQ and the
// edge-triggered NMI take the same 7-cycle entry sequence, so BA must stall
// and release them identically.
const SOURCES = [
  { name: 'IRQ', vector: 0x9000, arm: (m) => { m.cpu.setIrqLine(true); m.cpu.sampledIrq = true; } },
  { name: 'NMI', vector: 0xA000, arm: (m) => { m.cpu.setNmiLine(true); m.cpu.sampledNmiEdge = true; } },
];
for (const src of SOURCES) {
  // ── 1: ${src.name} entry on a clear bus (no BA-low) takes 7 master cycles ──────
  // Sanity baseline. CPU at instruction boundary, IRQ line asserted,
  // I=0 — first clock() begins ${src.name} entry. 7 master cycles later, PC=$${src.vector.toString(16)}.
  {
    const m = makeMachine(false);
    driveTo(m, 50, 0);                      // no bad lines under display-off
    src.arm(m);
    const n = cyclesUntilPc(m, src.vector);
    expect(n === 7,
      `clear-bus ${src.name} entry: PC=$${src.vector.toString(16)} after exactly 7 master cycles, got ${n}`);
    ok(`Bauer §3.13: NMOS ${src.name} entry takes 7 cycles on a clear bus`);
  }

  // ── 2: ${src.name} during bad-line BA — entry stalls on read cycles 1,2,6,7
  //
  // Place CPU at instruction boundary at cycle 11 of a bad line (BA-high).
  // Cycle 12 = bad-line BA falls. CPU enters cy 12 with sampledIrq=true.
  // Entry op 1 (read) wants to fire cycle 12 → BLOCKED. The two reads stay
  // blocked until cycle 55 when BA rises. After 43 stall cycles, both
  // reads complete; writes (3,4,5) proceed; final reads (6,7) complete.
  //
  // Total master cycles: ~ 7 + 43 = ~50, modulo when exactly the queue
  // shifts. We assert the entry takes at least 7 + 40 = 47 cycles
  // (lower bound) and at most 7 + 45 = 52 cycles (upper bound), and that
  // the handler PC IS reached.
  {
    const m = makeMachine(true);
    expect(m.vic2._isBadLine(0x33, m.vic2.regs),
      `precondition: raster $33 is a bad line under YSCROLL=3`);
    driveTo(m, 0x33, 11);
    // Make sure CPU is at instruction boundary; arm IRQ.
    m.cpu.instructionCyclesRemaining = 0;
    m.cpu.microOpHead = 0;
    m.cpu.microOpLen = 0;
    src.arm(m);

    const n = cyclesUntilPc(m, src.vector, 250);
    expect(n >= 47 && n <= 52,
      `bad-line ${src.name} entry: 7 + ~43 stall cycles ≈ 50; got ${n}`);
    ok(`Bauer §3.13 + §3.6.1: ${src.name} entry under bad-line BA defers read cycles for the full 43-cy window`);
  }

  // ── 3: ${src.name} during sprite-BA window — asymmetric 1-cy fall delay ────────
  //
  // Pre-seed sprite 0 DMA → BA-low from cy 55 through cy 59. Park CPU at
  // cy 54 with IRQ armed. Entry op 1 (read) fires cy 55 (BA-low but
  // asymmetric 1-cy delay → in-flight read completes). Entry op 2 (read)
  // blocks cycles 56..59 (BA still low, gate asserts). Cy 60: BA rises,
  // CPU resumes same cycle. Total expected: 7 + ~4 stall cycles = ~11
  // master cycles.
  {
    const m = makeMachine(false);
    m.vic2.spriteDmaOn[0] = 1;
    driveTo(m, 10, 54);
    expect(!m.vic2.isBadLineBaLow(), `precondition: not a bad line`);
    expect(!m.vic2.isSpriteBaLow(), `precondition: sprite BA still high at cy 54`);

    m.cpu.instructionCyclesRemaining = 0;
    m.cpu.microOpHead = 0;
    m.cpu.microOpLen = 0;
    src.arm(m);

    const n = cyclesUntilPc(m, src.vector, 100);
    expect(n >= 9 && n <= 13,
      `sprite-BA ${src.name} entry: 7 + ~4 stall cycles ≈ 11; got ${n}`);
    ok(`Bauer §3.13 + asymmetric sprite-BA: ${src.name} entry pays ~4 stall cycles per 5-cy sprite-BA window`);
  }

  // ── 4: ${src.name} entry starts on the very cycle BA rises (no release delay)
  // Park CPU at cy 54 boundary (BA still low; cy 54 has run as the last
  // stalled cycle). Arm IRQ. The next master cycle (cy 55) is the
  // rising-edge cycle — entry op 1 (read) MUST run THIS cycle, not the
  // next. Total: 7 entry cycles → pc=$9000 detected after master cycle 7.
  {
    const m = makeMachine(true);
    driveTo(m, 0x33, 54);
    expect(m.vic2.isBadLineBaLow(),
      `precondition: bad-line BA low at cy 54 (still in 12..54 window)`);

    m.cpu.instructionCyclesRemaining = 0;
    m.cpu.microOpHead = 0;
    m.cpu.microOpLen = 0;
    src.arm(m);

    const n = cyclesUntilPc(m, src.vector, 20);
    expect(n === 7,
      `rising-edge entry: 7 master cycles to reach the handler, got ${n}`);
    ok(`Bauer §3.13: ${src.name} entry resumes immediately on BA rising edge (cy 55 = entry op 1, no release delay)`);
  }

}

console.log(`\n${testNo} IRQ/NMI entry under BA spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
