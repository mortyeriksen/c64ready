// NMOS 6502 branch-no-cross IRQ/NMI delay.
//
// Rule: a taken branch that does NOT cross a page boundary delays
// IRQ/NMI recognition by exactly one instruction boundary. Page-crossed
// branches don't trigger this. The flag is set in the branch's final
// micro-op and consumed at the next instruction's _beginMicroInstruction
// interrupt-dispatch check.

import { CPU } from '../src/cpu.js';

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
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

// ── 1: BNE taken, no page cross — flag is set ──────────────────────────
{
  const mem = new FlatMemory();
  // BNE -2 (branch to self) at $0400. Z=0 so branch is taken,
  // target is $0400 → no page cross.
  mem.ram[0x0400] = 0xD0;        // BNE
  mem.ram[0x0401] = 0xFE;        // -2 → loops to $0400
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu.Z = 0;
  // 3 cycles for taken-no-cross branch.
  cpu.clock(); cpu.clock(); cpu.clock();
  expect(cpu._branchIrqNoCrossDelay === true,
    `BNE taken-no-cross: _branchIrqNoCrossDelay must be set after final cycle`);
  expect(cpu.pc === 0x0400,
    `BNE -2 target landed at $0400, got $${cpu.pc.toString(16)}`);
  ok('NMOS: branch-taken-no-cross sets _branchIrqNoCrossDelay flag');
}

// ── 2: BNE taken, page-crossed — flag NOT set ──────────────────────────
{
  const mem = new FlatMemory();
  // BNE +5 at $04FD: PC after operand is $04FF, +5 = $0504 → page cross.
  mem.ram[0x04FD] = 0xD0;
  mem.ram[0x04FE] = 0x05;
  const cpu = new CPU(mem);
  cpu.pc = 0x04FD; cpu.sp = 0xFF; cpu.I = 0; cpu.Z = 0;
  // 4 cycles for taken-page-crossed branch.
  for (let i = 0; i < 4; i++) cpu.clock();
  expect(cpu._branchIrqNoCrossDelay === false,
    `BNE taken page-crossed: _branchIrqNoCrossDelay must NOT be set`);
  expect(cpu.pc === 0x0504,
    `BNE +5 from $04FF crosses to $0504, got $${cpu.pc.toString(16)}`);
  ok('NMOS: branch-taken-page-crossed does NOT set the delay flag');
}

// ── 3: BNE not-taken — flag NOT set ────────────────────────────────────
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0xD0;
  mem.ram[0x0401] = 0x10;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu.Z = 1; // not taken
  cpu.clock(); cpu.clock();
  expect(cpu._branchIrqNoCrossDelay === false,
    `BNE not-taken: _branchIrqNoCrossDelay must NOT be set`);
  ok('NMOS: branch-not-taken does NOT set the delay flag');
}

// ── 4: IRQ asserted AFTER branch-no-cross — vectoring is delayed ──────
// NMOS 6502 quirk: when a taken-no-cross
// branch's penultimate-cycle IRQ poll DOES NOT see the IRQ (because the
// IRQ asserts after that sample), the next instruction boundary's poll
// also defers the IRQ — vectoring happens one instruction late.
//
// In our impl the closure at branch cycle 3 reads `sampledIrq` (already
// refreshed at clock(3) start). If sampledIrq=false there, irqLine
// hadn't yet asserted when cycle 3 began → delay flag SET. Subsequent
// IRQ assertion is then deferred by one instruction.
//
// Why this matches Bauer / NMOS reference: the "branch quirk" delay
// applies only when the branch's last-cycle IRQ poll misses the IRQ.
// If IRQ asserted BEFORE the branch's last cycle, the poll catches it
// and no delay is needed (tested in 4b/4c).
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x10;  // IRQ vector → $1000
  // BNE +0 at $0400: PC after operand = $0402, target = $0402, no cross.
  mem.ram[0x0400] = 0xD0; mem.ram[0x0401] = 0x00;
  mem.ram[0x0402] = 0xEA;  // NOP
  mem.ram[0x0403] = 0xEA;  // NOP

  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu.Z = 0;
  // IRQ is NOT asserted during the branch — only after.
  cpu.clock(); cpu.clock(); cpu.clock();  // BNE cycles 1, 2, 3 (no IRQ)
  expect(cpu.pc === 0x0402, `BNE +0 landed at $0402, got $${cpu.pc.toString(16)}`);
  expect(cpu._branchIrqNoCrossDelay === true,
    `delay flag SET when sampledIrq was false at branch cycle 3`);
  expect(cpu.sampledIrq === false,
    `sampledIrq false at branch end (IRQ not yet asserted)`);

  // IRQ asserts AFTER the branch.
  cpu.irqLine = true;
  // Next instruction (NOP) at $0402. Per the NMOS quirk, the delay flag
  // is consumed at this boundary; NOP runs even though IRQ is pending.
  cpu.clock();              // NOP cycle 1 — boundary check consumes delay flag
  expect(cpu._branchIrqNoCrossDelay === false,
    `delay flag consumed at the boundary after branch`);
  cpu.clock();              // NOP cycle 2
  expect(cpu.pc === 0x0403,
    `NMOS quirk: NOP after branch-no-cross runs before IRQ, ` +
    `got PC=$${cpu.pc.toString(16)}`);
  // Now IRQ vectors at the next boundary (7 cy for IRQ entry).
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x1000,
    `IRQ vectors at the NEXT boundary, got PC=$${cpu.pc.toString(16)}`);
  ok('NMOS: branch-no-cross delays IRQ recognition by one instruction boundary (IRQ asserts after branch)');
}

// ── 4b: IRQ asserted BEFORE branch — delay does NOT apply (audit #3) ───
// If IRQ is asserted from before the branch begins (= continuously low
// across the branch), the branch's "early poll" (NMOS end of cycle 1)
// catches it and the delay flag is NOT set. Without this guard, a tight
// branch loop with continuously-asserted IRQ would defer the IRQ
// indefinitely — every iteration re-sets the delay flag, every boundary
// consumes it and skips the IRQ.
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;  // IRQ vector → $9000
  mem.ram[0x0400] = 0xD0; mem.ram[0x0401] = 0xFE;  // BNE -2 (loops to self)

  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu.Z = 0;
  cpu.setIrqLine(true);    // IRQ asserted BEFORE any clock — continuous

  // Run a single BNE iteration (3 cycles).
  cpu.clock(); cpu.clock(); cpu.clock();
  expect(cpu._branchIrqNoCrossDelay === false,
    `delay flag NOT set when IRQ was caught at the branch's early poll`);
  expect(cpu.pc === 0x0400, `BNE -2 loops back to $0400`);

  // Boundary at cycle 4: IRQ should be accepted (delay flag is false).
  // After 7 more cycles of IRQ entry, pc must be at the vector $9000.
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `IRQ taken at boundary after branch (no spurious delay), got PC=$${cpu.pc.toString(16)}`);

  ok('NMOS: continuously-asserted IRQ accepted at branch boundary (no infinite deferral)');
}

// ── 4d: Late first-sampled IRQ on branch final cycle is delayed ────────
// A VIC IRQ raised during CPU phi2 reaches the CPU as a late first-sample
// on the following cycle. A taken-no-cross branch can see sampledIrq=true
// during its final cycle while still missing the branch's early poll, so
// the one-boundary delay applies.
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  mem.ram[0x0400] = 0xD0; mem.ram[0x0401] = 0x00;  // BNE +0
  mem.ram[0x0402] = 0xEA;

  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu.Z = 0;
  cpu.clock(); cpu.clock();       // branch cycles 1 and 2
  cpu.setIrqLine(true, true);     // late first-sample for branch cycle 3
  cpu.clock();                    // branch cycle 3
  expect(cpu.sampledIrq === true, `late IRQ was sampled on branch final cycle`);
  expect(cpu.sampledIrqLate === true, `branch final-cycle sample must carry late tag`);
  expect(cpu._branchIrqNoCrossDelay === true,
    `taken-no-cross branch must delay IRQ when only a late first-sample saw it`);

  cpu.clock(); cpu.clock();       // NOP after delayed boundary
  expect(cpu.pc === 0x0403,
    `late first-sample branch delay lets one NOP run before IRQ, got PC=$${cpu.pc.toString(16)}`);
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `late first-sample IRQ vectors at next boundary, got PC=$${cpu.pc.toString(16)}`);

  ok('NMOS: branch-no-cross delays IRQ for late first-sample on final branch cycle');
}

// ── 4e: First full-cycle IRQ sample on branch final cycle is delayed ───
// The branch's early poll uses the PREVIOUS cycle's IRQ sample. So if the
// line first becomes visible as a normal (non-late) sample on the final
// branch cycle, the early poll still missed it and one instruction must
// run before IRQ entry.
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  mem.ram[0x0400] = 0xD0; mem.ram[0x0401] = 0x00;  // BNE +0
  mem.ram[0x0402] = 0xEA;
  mem.ram[0x0403] = 0xEA;

  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu.Z = 0;
  cpu.clock(); cpu.clock();       // branch cycles 1 and 2
  cpu.setIrqLine(true, false);    // first full sample happens on cycle 3
  cpu.clock();                    // branch cycle 3
  expect(cpu.sampledIrqPrev === false,
    `previous-cycle sample was still low before the final branch cycle`);
  expect(cpu.sampledIrq === true && cpu.sampledIrqLate === false,
    `final branch cycle sees the first full IRQ sample`);
  expect(cpu._branchIrqNoCrossDelay === true,
    `taken-no-cross branch delays IRQ when the first full sample arrives on the final cycle`);

  cpu.clock(); cpu.clock();       // next NOP runs before IRQ
  expect(cpu.pc === 0x0403,
    `one NOP must run before IRQ entry when the early poll missed; got PC=$${cpu.pc.toString(16)}`);
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `IRQ vectors on the boundary after that NOP; got PC=$${cpu.pc.toString(16)}`);

  ok('NMOS: branch-no-cross delays IRQ for first full sample on final branch cycle');
}

// ── 4c: BNE-self loop with pending IRQ accepts within bounded cycles ────
// Regression: the pre-audit-#3 impl set the delay flag unconditionally
// every taken-no-cross branch, so a tight BNE-self loop with continuous
// IRQ would defer indefinitely (probed: 60 cycles, pc still at $0400).
// After audit #3 fix: IRQ accepted within ~10 cycles.
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  mem.ram[0x0400] = 0xD0; mem.ram[0x0401] = 0xFE;

  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu.Z = 0;
  cpu.setIrqLine(true);

  let irqAcceptedAtCycle = -1;
  for (let i = 1; i <= 30; i++) {
    cpu.clock();
    if (cpu.pc === 0x9000 && irqAcceptedAtCycle < 0) irqAcceptedAtCycle = i;
  }
  expect(irqAcceptedAtCycle >= 0,
    `IRQ must be accepted within 30 cycles (was ${irqAcceptedAtCycle < 0 ? 'NEVER' : irqAcceptedAtCycle})`);
  expect(irqAcceptedAtCycle <= 15,
    `IRQ accepted within ~10-15 cycles (3 cy 1st branch + 7 cy IRQ entry), got ${irqAcceptedAtCycle}`);

  ok('NMOS: tight BNE-self loop with pending IRQ accepts within bounded cycles');
}

// ── 5: IRQ asserted during branch-page-crossed — no extra delay ────────
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x10;
  // BNE +5 at $04FD → $0504 (page crossed).
  mem.ram[0x04FD] = 0xD0; mem.ram[0x04FE] = 0x05;
  mem.ram[0x0504] = 0xEA;
  const cpu = new CPU(mem);
  cpu.pc = 0x04FD; cpu.sp = 0xFF; cpu.I = 0; cpu.Z = 0;
  cpu.clock();              // BNE cycle 1
  cpu.irqLine = true;
  for (let i = 0; i < 3; i++) cpu.clock();   // cycles 2..4 of BNE
  expect(cpu._branchIrqNoCrossDelay === false,
    `crossed branch: flag NOT set`);
  // IRQ vectors at the next boundary (no extra delay).
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x1000,
    `IRQ vectors at next boundary (no delay), got PC=$${cpu.pc.toString(16)}`);
  ok('NMOS: branch-page-crossed does NOT delay IRQ');
}

// ── 6a: NMI present at the branch's early poll → NOT delayed (symmetric with
//        IRQ test 5). The branch-no-cross delay is now per-source: an NMI whose
//        edge was already visible at the early poll is accepted at the branch
//        boundary, no intervening NOP. (The old shared flag wrongly delayed it,
//        because it was set from IRQ-only early-poll state.)
{
  const mem = new FlatMemory();
  mem.ram[0xFFFA] = 0x00; mem.ram[0xFFFB] = 0x20;  // NMI vector → $2000
  mem.ram[0x0400] = 0xD0; mem.ram[0x0401] = 0x00;  // BNE +0 (taken, no cross)
  mem.ram[0x0402] = 0xEA; mem.ram[0x0403] = 0xEA;  // NOPs (must NOT run before NMI)

  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 1; cpu.Z = 0;
  cpu.clock();                 // BNE cycle 1
  cpu.setNmiLine(true);        // NMI edge — visible by the branch's early poll
  cpu.clock(); cpu.clock();    // BNE cycles 2 + 3
  expect(cpu._branchNmiNoCrossDelay === false,
    `NMI caught at early poll → NMI branch-delay NOT set`);
  expect(cpu.nmiEdge === true, `nmiEdge pending`);
  // NMI vectors at the FIRST boundary after the branch — $0402 NOP never runs.
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x2000,
    `NMI vectors directly at the branch boundary (no NOP), got PC=$${cpu.pc.toString(16)}`);
  ok('NMOS: branch-no-cross does NOT delay an NMI caught at the early poll');
}

// ── 6b: NMI that ARRIVES after the early poll → delayed by one boundary (NOP
//        runs first). This is the genuine branch-no-cross NMI delay.
{
  const mem = new FlatMemory();
  mem.ram[0xFFFA] = 0x00; mem.ram[0xFFFB] = 0x20;  // NMI vector → $2000
  mem.ram[0x0400] = 0xD0; mem.ram[0x0401] = 0x00;  // BNE +0
  mem.ram[0x0402] = 0xEA; mem.ram[0x0403] = 0xEA;  // NOPs

  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 1; cpu.Z = 0;
  cpu.clock(); cpu.clock();    // BNE cycles 1 + 2 (early poll sees NO NMI)
  cpu.setNmiLine(true);        // NMI arrives LATE — after the early poll
  cpu.clock();                 // BNE cycle 3 (final) → sets the NMI branch delay
  expect(cpu._branchNmiNoCrossDelay === true,
    `NMI arrived after the early poll → NMI branch-delay SET`);
  // Delayed: the $0402 NOP runs before the NMI vectors.
  cpu.clock(); cpu.clock();    // NOP (2 cy)
  expect(cpu.pc === 0x0403,
    `NOP runs before the delayed NMI, got PC=$${cpu.pc.toString(16)}`);
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x2000,
    `NMI vectors at the following boundary, got PC=$${cpu.pc.toString(16)}`);
  ok('NMOS: branch-no-cross DELAYS an NMI that arrives after the early poll');
}

if (testsFailing > 0) {
  console.log(`\n${testsFailing} of ${testNo} tests FAILED`);
  process.exit(1);
}
console.log(`\nAll ${testNo} tests passed`);
