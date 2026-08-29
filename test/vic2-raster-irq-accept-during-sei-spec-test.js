// Raster-IRQ accept through an SEI critical section — end-to-end spec test.
//
// Locks the integrated behavior the Coma Light 13 wide-plasma timing (and any
// stable-raster effect that runs an SEI…CLI critical section) depends on: a
// VIC-II raster IRQ that asserts while the CPU has interrupts masked (I=1) must
// be HELD pending — across arbitrarily many raster lines — and then accepted at
// the spec-exact cycle once CLI re-enables interrupts.
//
// Unit coverage of the two halves already exists (vic2-raster-irq-edge-trigger,
// irq-latency for the assert cycle; nested-irq-cli, cpu-irq-sampled-only for the
// CLI shadow). This pins the COMBINED path with a real VIC + CPU coupled like
// the machine (vic.clock then cpu.clock per master cycle), so an integration
// regression in the VIC-IRQ-line ↔ CPU-I-flag gating is caught.
//
// Spec citations:
//   - Bauer §3.12: the VIC raster compare asserts the IRQ at cycle 1 of the
//     target raster; $D019 bit0 latches and (with $D01A bit0 set) the CPU IRQ
//     line is pulled low and STAYS low until acknowledged.
//   - MOS 6510: while I=1 the IRQ line is ignored (held pending, not lost).
//   - MOS 6510 CLI shadow: CLI clears I at end of its 2 cycles but the
//     interrupt check for the NEXT instruction still uses the OLD I=1, so a
//     pending IRQ is accepted only at the boundary AFTER the instruction
//     following CLI.
//   - MOS 6510 IRQ entry: exactly 7 cycles (2 dummy + push PCH/PCL/P + vector
//     lo/hi) before the first handler opcode fetch.

import { CPU } from '../src/cpu.js';
import { VIC2 } from '../src/vic2.js';

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

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

// Build a coupled CPU+VIC. Main program bytes at `mainPC`, handler at $9000,
// IRQ vector → $9000. Raster IRQ armed at raster `rcmp`. CPU starts at mainPC.
function makeMachine({ main, mainPC = 0x0400, handler, rcmp = 100 }) {
  const mem = new FlatMemory();
  main.forEach((b, i) => { mem.ram[mainPC + i] = b; });
  handler.forEach((b, i) => { mem.ram[0x9000 + i] = b; });
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  mem.ram[0xFFFC] = mainPC & 0xFF; mem.ram[0xFFFD] = (mainPC >> 8) & 0xFF;
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();   // consume reset-boot
  const vic = new VIC2();
  vic.ram = mem.ram; vic.colorRam = new Uint8Array(0x0400); vic.charRom = new Uint8Array(0x1000);
  vic.regs[0x12] = rcmp; vic.regs[0x1A] = 0x01; vic.irqMask = 0x01;
  vic.irqHandler = (s) => cpu.setIrqLine(!!s);
  return { cpu, vic, mem };
}
// One master cycle: VIC then CPU (machine order).
function tick(m) { m.vic.clock(1); m.cpu.clock(); }
// Park the CPU at a fresh instruction boundary at `pc`.
function park(cpu, pc) { cpu.pc = pc; cpu.instructionCyclesRemaining = 0; cpu.microOpHead = 0; cpu.microOpLen = 0; }

// ── 1: raster IRQ asserts the CPU line, but I=1 HOLDS it across raster lines ──
{
  // Main loop: JMP $0400 (3 cy) forever. Handler: STA $0500 (sentinel $55).
  const m = makeMachine({ main: [0x4C, 0x00, 0x04], handler: [0x8D, 0x00, 0x05] });
  m.cpu.I = 1; m.cpu.a = 0x55; park(m.cpu, 0x0400);

  // Run until the VIC pulls the IRQ line low (raster 100).
  let guard = 60000, asserted = false;
  while (guard-- && !m.cpu.irqLine) { tick(m); if (m.cpu.irqLine) asserted = true; }
  expect(asserted, 'VIC must assert the CPU IRQ line at the raster compare');
  expect(m.vic.raster === 100, `IRQ should assert at raster 100, got ${m.vic.raster}`);

  // With I=1, hold for >2 full raster lines (2*63 cycles). Handler must NOT run.
  for (let i = 0; i < 2 * 63; i++) tick(m);
  expect(m.cpu.irqLine === true, 'IRQ line stays asserted (latched, unacknowledged)');
  expect(m.mem.ram[0x0500] !== 0x55, 'handler must NOT run while I=1 (IRQ held pending)');
  expect(m.cpu.pc >= 0x0400 && m.cpu.pc <= 0x0402, `CPU still in the JMP loop, got $${m.cpu.pc.toString(16)}`);
  expect(m.cpu.I === 1, 'I flag still set');
  ok('Bauer §3.12 + 6510: raster IRQ asserts the CPU line and is HELD pending across raster lines while I=1');
}

// ── 2: CLI accepts the held raster IRQ at the spec-exact cycle ──────────────
// IRQ already pending (raster matched, line latched). Park CPU at:
//   $0500 CLI ; $0501 NOP ; $0502 JMP $0500     handler $9000: STA $0500-sentinel
// Spec accept latency from the CLI boundary to the handler's STORE cycle:
//   CLI(2) + NOP-shadow(2) + entry(7) + STA-abs(4, store on cy4) = 15 cycles.
// And the handler must NOT run during the CLI+shadow (the first 4 cycles).
{
  const m = makeMachine({ main: [0x4C, 0x00, 0x04], handler: [0x8D, 0x10, 0x05] }); // STA $0510
  m.cpu.I = 1; m.cpu.a = 0x55; park(m.cpu, 0x0400);
  // reach the raster-IRQ assertion with I=1 (held)
  let guard = 60000; while (guard-- && !m.cpu.irqLine) tick(m);
  expect(m.cpu.irqLine === true, 'pre: IRQ pending');

  // Install the CLI sequence and park there at a clean boundary.
  m.mem.ram[0x0500] = 0x58;       // CLI
  m.mem.ram[0x0501] = 0xEA;       // NOP (CLI shadow)
  m.mem.ram[0x0502] = 0x4C; m.mem.ram[0x0503] = 0x00; m.mem.ram[0x0504] = 0x05; // JMP $0500
  park(m.cpu, 0x0500);

  // Step cycle-by-cycle from the CLI boundary, recording when the handler's
  // store lands and that nothing ran before the shadow elapsed.
  let writeCy = -1, enteredEarly = false;
  for (let c = 1; c <= 20; c++) {
    tick(m);
    if (c <= 4 && m.cpu.pc === 0x9000) enteredEarly = true; // entry during CLI(2)+NOP(2)
    if (writeCy < 0 && m.mem.ram[0x0510] === 0x55) writeCy = c;
  }
  expect(!enteredEarly, 'IRQ must NOT be entered during CLI + its 1-instruction shadow');
  expect(m.cpu.I === 1, `IRQ entry re-masks interrupts (I=1 inside the handler); got I=${m.cpu.I}`);
  expect(writeCy === 15,
    `accept latency CLI→handler store must be 15 cy (CLI 2 + NOP shadow 2 + entry 7 + STA 4); got ${writeCy}`);
  ok('6510 CLI shadow + 7-cy entry: held raster IRQ accepted exactly 15 cy after the CLI boundary');
}

// ── 3: the held IRQ is the SAME raster event — accept is independent of how ──
// long it was held (no extra latency for a longer SEI section). Hold ~5 lines
// before CLI; the CLI→store latency must still be exactly 15.
{
  const m = makeMachine({ main: [0x4C, 0x00, 0x04], handler: [0x8D, 0x20, 0x05] }); // STA $0520
  m.cpu.I = 1; m.cpu.a = 0x55; park(m.cpu, 0x0400);
  let guard = 60000; while (guard-- && !m.cpu.irqLine) tick(m);
  for (let i = 0; i < 5 * 63; i++) tick(m);     // hold ~5 rasters longer
  expect(m.mem.ram[0x0520] !== 0x55, 'still held after ~5 extra rasters');
  m.mem.ram[0x0500] = 0x58; m.mem.ram[0x0501] = 0xEA;
  m.mem.ram[0x0502] = 0x4C; m.mem.ram[0x0503] = 0x00; m.mem.ram[0x0504] = 0x05;
  park(m.cpu, 0x0500);
  let writeCy = -1;
  for (let c = 1; c <= 20; c++) { tick(m); if (writeCy < 0 && m.mem.ram[0x0520] === 0x55) writeCy = c; }
  expect(writeCy === 15, `accept latency must be 15 cy regardless of hold duration; got ${writeCy}`);
  ok('accept latency after CLI is fixed (15 cy) independent of SEI-section length');
}

console.log(`\n${testNo} raster-IRQ-accept-during-SEI spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
