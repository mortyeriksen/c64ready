// IRQ acceptance flows EXCLUSIVELY through _beginMicroInstruction's
// sampled-IRQ path. The legacy level-sensitive IRQ check (a live-line
// read, removed in 075f035 → next) is gone: an IRQ
// asserted at the very cycle the CPU is at an instruction boundary
// must NOT be accepted that cycle. Instead, the current cycle dispatches
// normally; sampledIrq is refreshed at end-of-cycle; and the IRQ entry
// begins at the NEXT instruction boundary.
//
// This matches NMOS 6502 spec: IRQ pin sampled during phi2; recognized
// at the end of the LAST cycle of the current instruction; entry begins
// on the cycle AFTER. Removing the legacy live-line check eliminates a
// 1-cycle-too-early IRQ acceptance that could shift stable-IRQ
// scrollers and FPP-class side-border timing.

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

function makeCpu(mem) {
  const cpu = new CPU(mem);
  cpu.pc = 0x1000; cpu.sp = 0xFF;
  cpu.I = 0;                    // IRQ enabled
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0; cpu.microOpLen = 0;
  cpu.sampledIrq = false;
  cpu.irqLine = false;
  cpu.nmiEdge = false;
  cpu.nmiLine = false;
  cpu._branchNoCrossDelay = false;
  cpu._pollI = cpu.I;
  return cpu;
}

// ── 1: IRQ asserted at instruction boundary → deferred to next boundary ──
// IRQ asserted in the SAME cycle the CPU has irc=0 (instruction boundary).
// The legacy path would have accepted same-cycle via live `irqLine`. The
// sampled path defers acceptance by one instruction.
{
  const mem = new FlatMemory();
  mem.ram[0x1000] = 0xEA;             // NOP (2 cycles)
  mem.ram[0xFFFE] = 0x00;             // IRQ vector low
  mem.ram[0xFFFF] = 0x90;             // IRQ vector high → $9000
  const cpu = makeCpu(mem);

  // Assert IRQ just before the cycle CPU dispatches. sampledIrq still
  // false from prior (nonexistent) cycles — this mirrors VIC asserting
  // IRQ in vic.clock() before cpu.clock() runs in the same master cycle.
  cpu.setIrqLine(true);
  expect(cpu.sampledIrq === false,
    `pre-c1: sampledIrq remains false (pin just asserted, not yet sampled)`);

  // Cycle 1: instruction boundary. _beginMicroInstruction sees
  // sampledIrq=false → no IRQ vectoring; it dispatches the NOP via the
  // micro-op queue. sampledIrq refreshes to true at end-of-cycle.
  cpu.clock();
  expect(cpu.pc === 0x1001,
    `c1: NOP must execute, pc advanced to $1001, got $${cpu.pc.toString(16)}`);
  expect(cpu.sampledIrq === true,
    `c1 end: sampledIrq sampled live irqLine, must be true`);
  expect(cpu.instructionCyclesRemaining === 1,
    `c1: NOP returned 2 cycles, decremented to 1, got ${cpu.instructionCyclesRemaining}`);

  // Cycle 2: NOP's second cycle drains. No interrupt processing yet —
  // we're mid-instruction.
  cpu.clock();
  expect(cpu.instructionCyclesRemaining === 0,
    `c2: NOP complete, irc=0, got ${cpu.instructionCyclesRemaining}`);
  expect(cpu.pc === 0x1001,
    `c2: pc unchanged (NOP completing), got $${cpu.pc.toString(16)}`);

  // Cycle 3: next instruction boundary. sampledIrq=true → IRQ entry
  // queued via _beginMicroInstruction. irc=7 for the 7-cycle entry.
  cpu.clock();
  expect(cpu.instructionCyclesRemaining === 6,
    `c3: IRQ entry queued (first micro-op consumed this cycle), irc=6, got ${cpu.instructionCyclesRemaining}`);

  // Cycles 4..9: complete the remaining 6 IRQ micro-ops (push PCH, push
  // PCL, push P, read vector low, read vector high, plus one dummy).
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `after 7-cycle IRQ entry: pc at IRQ vector $9000, got $${cpu.pc.toString(16)}`);
  expect(cpu.I === 1,
    `after IRQ entry: I flag set, got ${cpu.I}`);

  ok('IRQ asserted at instruction boundary deferred to next boundary (sampled, not live)');
}

// ── 2: IRQ asserted DURING an instruction is sampled, accepted at next boundary ──
// IRQ asserts mid-instruction (between LDA's two micro-ops). Verifies
// the sampledIrq update path during the non-dispatch cycles also works.
{
  const mem = new FlatMemory();
  mem.ram[0x1000] = 0xA9;             // LDA #$nn (2 cycles: opcode fetch, operand)
  mem.ram[0x1001] = 0x42;
  mem.ram[0xFFFE] = 0x00;
  mem.ram[0xFFFF] = 0x90;
  const cpu = makeCpu(mem);

  // Cycle 1: LDA opcode fetched, pc advances to operand. A NOT yet loaded
  // (operand fetched in cycle 2 via the second micro-op). NO IRQ pending.
  cpu.clock();
  expect(cpu.a === 0x00,
    `c1: LDA still mid-instruction (A loads in cycle 2), got A=$${cpu.a.toString(16)}`);
  expect(cpu.instructionCyclesRemaining === 1, `c1: irc=1 after opcode fetch`);
  expect(cpu.sampledIrq === false, `c1 end: still no IRQ asserted`);

  // IRQ asserts mid-instruction (between cycle 1 and cycle 2).
  cpu.setIrqLine(true);

  // Cycle 2: LDA's operand fetch. A=$42 lands. sampledIrq refreshed to
  // true here (line 297-298 of cpu.clock).
  cpu.clock();
  expect(cpu.a === 0x42,
    `c2: A loaded, got A=$${cpu.a.toString(16)}`);
  expect(cpu.sampledIrq === true,
    `c2 end: sampledIrq picked up mid-instruction assertion, got ${cpu.sampledIrq}`);
  expect(cpu.instructionCyclesRemaining === 0, `c2: LDA done, irc=0`);

  // Cycle 3: instruction boundary. IRQ entry begins (7-cycle sequence).
  cpu.clock();
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `IRQ entry from mid-instruction assertion vectored to $9000, got $${cpu.pc.toString(16)}`);

  ok('IRQ asserted mid-instruction sampled and accepted at next boundary');
}

// ── 3: IRQ asserted with I=1 stays pending; CLI lifts mask without ───────
// immediate IRQ (1-instruction shadow); next instruction accepts it.
{
  const mem = new FlatMemory();
  mem.ram[0x1000] = 0x58;             // CLI (2 cycles)
  mem.ram[0x1001] = 0xEA;             // NOP — runs in the CLI shadow
  mem.ram[0x1002] = 0xEA;             // NOP after shadow — IRQ accepted here
  mem.ram[0xFFFE] = 0x00;
  mem.ram[0xFFFF] = 0x90;
  const cpu = makeCpu(mem);
  cpu.I = 1;                          // start with IRQ masked
  cpu.setIrqLine(true);               // IRQ pending the whole time

  // Cycle 1: CLI dispatches via the micro-op queue — its handler sets
  // I=0; the poll-visible I keeps the old value until the next boundary
  // (the 1-instruction shadow). sampledIrq updates at end-of-cycle.
  cpu.clock();
  expect(cpu.I === 0, `c1: CLI cleared I, got I=${cpu.I}`);

  // Cycle 2: CLI's second cycle.
  cpu.clock();
  expect(cpu.instructionCyclesRemaining === 0, `c2: CLI complete`);

  // Cycle 3: NOP at $1001. The shadow defers the IRQ exactly one
  // boundary — NOT taken even though sampledIrq=true and I=0.
  cpu.clock();
  expect(cpu.pc === 0x1002,
    `c3: NOP in CLI shadow ran, pc at $1002, got $${cpu.pc.toString(16)}`);

  // Cycle 4: NOP cycle 2.
  cpu.clock();

  // Cycle 5: next boundary. IRQ entry begins now.
  cpu.clock();
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `IRQ taken after CLI shadow, pc at $9000, got $${cpu.pc.toString(16)}`);

  ok('CLI shadow holds IRQ for exactly one instruction boundary');
}

// ── 4: NMI edge persists across cycles; accepted only via sampled path ──
// NMI is edge-triggered (nmiEdge latched once on the rising edge of
// nmiLine). With the legacy live-NMI check removed, nmiEdge is consumed
// only inside _beginMicroInstruction.
{
  const mem = new FlatMemory();
  mem.ram[0x1000] = 0xEA;             // NOP
  mem.ram[0xFFFA] = 0x00;             // NMI vector low
  mem.ram[0xFFFB] = 0xA0;             // NMI vector high → $A000
  const cpu = makeCpu(mem);

  cpu.setNmiLine(true);
  expect(cpu.nmiEdge === true, `setNmiLine(true) latches nmiEdge on rising edge`);
  cpu.sampledNmiEdge = true;          // edge sampled before the boundary (like sampledIrq)

  // Cycle 1: the NMI edge was SAMPLED before the boundary (sampledNmiEdge),
  // symmetric with the IRQ's sampledIrq path. _beginMicroInstruction sees
  // sampledNmiEdge=true → NMI entry queued; the live nmiEdge is no longer
  // checked directly at the boundary (no legacy live check).
  cpu.clock();
  expect(cpu.instructionCyclesRemaining === 6,
    `c1: NMI entry queued (first micro-op consumed), irc=6, got ${cpu.instructionCyclesRemaining}`);
  expect(cpu.pc !== 0x1001,
    `c1: NOP NOT executed (NMI took priority at boundary)`);

  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.pc === 0xA000,
    `after 7-cycle NMI entry: pc at vector $A000, got $${cpu.pc.toString(16)}`);
  expect(cpu.nmiEdge === false,
    `after NMI entry: nmiEdge cleared by _queueInterruptMicroOps`);

  ok('NMI accepted at boundary via sampled-edge path (no legacy live check)');
}

console.log(`\n${testNo} CPU IRQ sampled-only-path tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
