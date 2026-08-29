// CPU IRQ-sampling timing spec audit. 10 tests on the 1-cycle window
// where IRQ assertion either takes effect immediately or is delayed
// to the next instruction. Derived from the MOS6502/MOS6510 reference
// and the visible-software behavior of CLI/SEI/PLP/RTI shadows.
//
// Rules:
//  - IRQ pin is sampled at phi2 of every cycle.
//  - "Effective" sampling cycle: penultimate cycle of an instruction.
//  - IRQ asserted in the LAST cycle is delayed one instruction.
//  - I flag transitions via CLI/PLP shadow the next instruction (the
//    next instruction runs uninterruptible even if IRQ is asserted).
//  - SEI takes effect on the next instruction (same shadow).
//  - RTI does NOT shadow — pulled-from-stack I flag is in effect for
//    the very next opcode fetch.

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

// ── 1: IRQ asserted before opcode fetch + I=0 → vector entered first ──
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x10;   // IRQ vector → $1000
  mem.ram[0x0400] = 0xEA;                            // NOP
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu._pollI = 0;
  cpu.irqLine = true;
  cpu.sampledIrq = true;
  // Drive exactly 7 cycles for IRQ entry.
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x1000,
    `IRQ asserted with I=0 must vector to $FFFE → $1000, got PC=$${cpu.pc.toString(16)}`);
  ok('6502: IRQ asserted + I=0 → vector entered before next instruction');
}

// ── 1b: live IRQ at an unsampled opcode boundary is not retroactive ───
// A plain CPU clock only acts on IRQ levels sampled during prior CPU cycles.
// If irqLine is asserted after the previous instruction's sampling point,
// the next instruction runs and samples the level for the following boundary.
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x10;
  mem.ram[0x0400] = 0xEA;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu._pollI = 0;
  cpu.irqLine = true;
  cpu.sampledIrq = false;
  cpu.clock(); cpu.clock();             // NOP runs and samples irqLine=true
  expect(cpu.pc === 0x0401,
    `unsampled live IRQ must not preempt the NOP fetch, got PC=$${cpu.pc.toString(16)}`);
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x1000,
    `IRQ sampled by the NOP must vector at the following boundary, got PC=$${cpu.pc.toString(16)}`);
  ok('6502: unsampled live IRQ waits until the next instruction boundary');
}

// ── 2: IRQ blocked when I=1 (interrupt-disable) ───────────────────────
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x10;
  mem.ram[0x0400] = 0xEA;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 1; cpu._pollI = 1;
  cpu.irqLine = true;
  // Run NOP (2 cycles) — IRQ must NOT take vector.
  cpu.clock(); cpu.clock();
  expect(cpu.pc === 0x0401,
    `I=1: IRQ ignored, PC must advance past NOP, got $${cpu.pc.toString(16)}`);
  ok('6502: I=1 blocks IRQ (interrupt-disable)');
}

// ── 3: NMI is not blocked by I flag ──────────────────────────────────
{
  const mem = new FlatMemory();
  mem.ram[0xFFFA] = 0x78; mem.ram[0xFFFB] = 0x56;   // NMI → $5678
  mem.ram[0x0400] = 0xEA;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 1; cpu._pollI = 1;
  cpu.setNmiLine(true);
  cpu.sampledNmiEdge = true;     // edge sampled (symmetric with sampledIrq)
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x5678,
    `NMI not blocked by I flag, must vector to $5678, got $${cpu.pc.toString(16)}`);
  ok('6502: NMI vectoring is not blocked by I flag');
}

// ── 4: NMI is edge-triggered — holding the line does not refire ──────
// Only a low-to-high transition latches a pending NMI.
{
  const mem = new FlatMemory();
  mem.ram[0xFFFA] = 0x00; mem.ram[0xFFFB] = 0x10;
  mem.ram[0x1000] = 0x40;     // RTI from NMI handler
  mem.ram[0x0400] = 0xEA;     // NOP after return
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF;
  // Pre-stack a return frame for RTI (P, PCL, PCH).
  mem.ram[0x01FD] = 0x00;
  mem.ram[0x01FE] = 0x00;
  mem.ram[0x01FF] = 0x05;
  cpu.setNmiLine(true);
  cpu.sampledNmiEdge = true;     // edge sampled (symmetric with sampledIrq)
  // First NMI taken.
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x1000, `pre: NMI vectored to $1000`);
  cpu.sp = 0xFC;     // pretend return frame is set up by NMI push
  // Hold NMI line high (no edge) — next clock should NOT re-vector.
  // (Our impl tracks _nmiEdge; it's cleared after vector.)
  expect(cpu.nmiEdge === false,
    `after NMI vector: nmiEdge must be cleared (level high doesn't refire)`);
  ok('6502: NMI is edge-triggered (held high doesn\'t re-fire)');
}

// ── 5: NMI re-arms on falling-then-rising edge ─────────────────────────
{
  const cpu = new CPU(new FlatMemory());
  cpu.pc = 0x0400; cpu.sp = 0xFF;
  cpu.setNmiLine(true);
  expect(cpu.nmiEdge === true, `pre: rising edge latched`);
  cpu.nmiEdge = false;
  cpu.setNmiLine(false);
  cpu.setNmiLine(true);     // new rising edge
  expect(cpu.nmiEdge === true, `new rising edge re-latches NMI`);
  ok('6502: NMI re-arms on a fresh rising edge after low');
}

// ── 6: SEI takes effect at end of its own instruction ──────────────────
// SEI (1 byte, 2 cycles) sets I=1. Per spec, the I-set is visible to
// the next IRQ-sample point, which is during the next instruction.
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0x78;     // SEI
  mem.ram[0x0401] = 0xEA;     // NOP
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 0; cpu._pollI = 0;
  cpu.clock(); cpu.clock();   // 2 cycles SEI
  expect(cpu.I === 1, `after SEI: I=1`);
  ok('6502: SEI sets I flag by end of instruction');
}

// ── 7: CLI 1-instruction interrupt shadow ──────────────────────────────
// Bruce Clark §I-flag-delay: CLI/SEI/PLP write I in their final cycle,
// after the penultimate-cycle interrupt poll, so the new I value takes
// effect AFTER one more instruction. A pending IRQ does not fire at the
// boundary immediately after CLI — it fires after the NEXT instruction
// completes. This is the same shadow PLP exhibits (and, crucially, NOT
// the behavior of RTI — see test 10).
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x10;
  mem.ram[0x0400] = 0x58;     // CLI
  mem.ram[0x0401] = 0xEA;     // NOP — runs in the CLI shadow
  mem.ram[0x0402] = 0xEA;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 1; cpu._pollI = 1;
  cpu.setIrqLine(true); cpu.sampledIrq = true; cpu.sampledIrqPrev = true;
  cpu.clock(); cpu.clock();
  expect(cpu.I === 0, `after CLI: I=0`);
  // Behavior, not flags: the pending IRQ is NOT taken at CLI's boundary —
  // the shadowed NOP runs first, then the IRQ vectors.
  cpu.clock(); cpu.clock();   // NOP in the shadow
  expect(cpu.pc === 0x0402,
    `shadowed NOP ran before the IRQ; pc=$${cpu.pc.toString(16)}`);
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x1000,
    `IRQ vectors after exactly one shadowed instruction; pc=$${cpu.pc.toString(16)}`);
  ok('6502: CLI triggers a 1-instruction interrupt shadow (like PLP)');
}

// ── 8: PLP also shadows the next instruction ──────────────────────────
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x10;
  mem.ram[0x0400] = 0x28;     // PLP (pulls I=0)
  mem.ram[0x0401] = 0xEA;     // NOP — runs in the PLP shadow
  mem.ram[0x0402] = 0xEA;
  mem.ram[0x01FF] = 0x00;     // pulled P with I=0
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFE; cpu.I = 1; cpu._pollI = 1;
  cpu.setIrqLine(true); cpu.sampledIrq = true; cpu.sampledIrqPrev = true;
  for (let i = 0; i < 4; i++) cpu.clock();   // PLP (4 cycles)
  expect(cpu.I === 0, `after PLP: I=0 (from stack)`);
  cpu.clock(); cpu.clock();   // NOP in the shadow
  expect(cpu.pc === 0x0402,
    `shadowed NOP ran before the IRQ; pc=$${cpu.pc.toString(16)}`);
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x1000,
    `IRQ vectors after exactly one shadowed instruction; pc=$${cpu.pc.toString(16)}`);
  ok('6502: PLP triggers 1-instruction interrupt shadow');
}

// ── 9: RTI does NOT shadow — pulled I is effective immediately ─────────
// Unlike CLI/SEI/PLP (which write I in their FINAL cycle, after the
// penultimate-cycle interrupt poll), RTI pulls P in cycle 4 of 6 — before
// its own poll — so the restored I is in effect for the very next opcode
// fetch with no 1-instruction delay (Bruce Clark §I-flag-delay). This is
// exactly the property Bauer §3.12 describes: an un-acknowledged,
// state-sensitive IRQ "will be re-triggered immediately ... [when the
// processor] returns from the interrupt routine". Validated on hardware by
// VICE testprog interrupts/irqnoack/ackcia.prg (must report PASS).
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0x40;     // RTI
  // Stack frame: at sp+1=$01FD pulled first = P (I=0), then PCL, PCH.
  mem.ram[0x01FD] = 0x00;     // P with I=0
  mem.ram[0x01FE] = 0x00;
  mem.ram[0x01FF] = 0x05;     // → return to $0500
  mem.ram[0x0500] = 0xEA;     // NOP at the return target — must NOT run if
                              // the pending IRQ re-fires immediately.
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;   // IRQ vector → $9000
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFC; cpu.I = 1; cpu._pollI = 1;
  cpu.setIrqLine(true);       // IRQ pending throughout (never acknowledged)
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.I === 0, `after RTI: I=0 from stack`);
  expect(cpu.pc === 0x0500, `RTI returned to $0500; got $${cpu.pc.toString(16)}`);
  // Next boundary: the still-asserted IRQ vectors immediately, before the
  // NOP at $0500 can run. 7-cycle entry → pc at the IRQ vector $9000.
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `un-acked IRQ re-fires immediately after RTI — must vector to $9000, ` +
    `not run the return-target NOP; got $${cpu.pc.toString(16)}`);
  ok('6502: RTI has NO interrupt shadow — un-acked IRQ re-fires immediately (Bauer §3.12 / Bruce Clark §I-flag-delay)');
}

// ── 9b: CLI;SEI lets one already-pending IRQ slip through after SEI ────
// The interrupt poll that admits the IRQ runs during SEI with I still 0
// (the value CLI established one instruction earlier), so SEI re-setting
// I=1 cannot retract it — the classic NMOS "CLI;SEI" quirk (Bruce Clark
// §I-flag-delay). Validated on hardware by VICE testprog
// interrupts/irqnoack/ackcia3.prg (must report PASS).
{
  const mem = new FlatMemory();
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;   // IRQ vector → $9000
  mem.ram[0x0400] = 0x58;     // CLI  (arms shadow, I→0)
  mem.ram[0x0401] = 0x78;     // SEI  (I→1, but cannot retract the commit)
  mem.ram[0x0402] = 0xEA;     // NOP  — must NOT run before the IRQ fires
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.I = 1; cpu._pollI = 1;
  cpu.setIrqLine(true);       // IRQ pending throughout (never acknowledged)
  cpu.clock(); cpu.clock();   // CLI
  expect(cpu.I === 0, `after CLI: I=0`);
  cpu.clock(); cpu.clock();   // SEI
  expect(cpu.I === 1, `after SEI: I=1`);
  expect(cpu.pc === 0x0402,
    `CLI;SEI both ran; at NOP boundary $0402; got $${cpu.pc.toString(16)}`);
  // Next boundary: the committed IRQ vectors despite I=1, before the NOP.
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `CLI;SEI: the committed IRQ must vector to $9000, not run the NOP; ` +
    `got $${cpu.pc.toString(16)}`);
  ok('6502: CLI;SEI lets one already-pending IRQ through after SEI (Bruce Clark §I-flag-delay)');
}

// ── 10: peekNextBusKind returns 'read' at instruction boundary ────────
// Important for the BA-stall logic: at boundary the next access is a
// read (opcode fetch), so BA-low blocks it.
{
  const cpu = new CPU(new FlatMemory());
  cpu.pc = 0x0400;
  expect(cpu.peekNextBusKind() === 'read',
    `at instruction boundary: next bus access is a 'read' (opcode fetch)`);
  ok('6502: peekNextBusKind = "read" at instruction boundary (opcode fetch)');
}

console.log(`\n${testNo} CPU IRQ-sampling spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
