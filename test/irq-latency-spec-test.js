// IRQ entry latency spec audit. Probes the CPU↔VIC sync nine.prg's
// stable-IRQ technique depends on. Per Bauer §3.12 + 6510 IRQ semantics:
//
//   - VIC raster compare fires at cycle 1 of the target raster (cycle 2
//     for raster 0). When the matching IRQ mask bit is set, $D019 bit 0
//     latches and the CPU IRQ line is pulled low.
//   - 6510 samples the IRQ line at every phi2; recognition happens at the
//     end of the current instruction. With sampling at every cycle except
//     the last, an IRQ asserting at the LAST cycle of an instruction is
//     deferred by one instruction.
//   - IRQ entry takes exactly 7 cycles: 2 dummy reads + push PCH + push
//     PCL + push P (with B clear) + read vector low + read vector high.
//     I flag is set during cycle 5 (push P).
//
// nine.prg writes $D017 at a precise cycle offset from raster-IRQ
// assertion. If our entry latency is off by N cycles, the demo's MxYE
// crunch window is missed by N cycles.
//
// Each test is self-contained and asserts a discrete spec rule.

import { CPU } from '../src/cpu.js';
import { VIC2 } from '../src/vic2.js';

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

// Build a CPU at PC=$0400 with NOPs and a vector at $FFFE/F pointing to
// $9000 (handler). Return {cpu, mem}.
function makeCpuWithIrqVector(handlerLo = 0x00, handlerHi = 0x90) {
  const mem = new FlatMemory();
  // Fill program area with NOPs so we have something to run.
  for (let i = 0; i < 32; i++) mem.ram[0x0400 + i] = 0xEA; // NOP
  mem.ram[0xFFFE] = handlerLo;
  mem.ram[0xFFFF] = handlerHi;
  // Reset vector
  mem.ram[0xFFFC] = 0x00;
  mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  // Reset queues 7 dummy cycles per the 6510 boot sequence; consume them
  // so each test starts at a clean instruction-fetch boundary.
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 0; cpu._pollI = 0;                            // allow IRQs
  return { cpu, mem };
}

// Run cpu.clock() N times and return total cycles.
function runCycles(cpu, n) {
  let c = 0;
  for (let i = 0; i < n; i++) { cpu.clock(); c++; }
  return c;
}

// ── 1: IRQ entry takes exactly 7 cycles ────────────────────────────────
// 6510 IRQ entry sequence: dummy read, dummy read, push PCH, push PCL,
// push P, read vector lo, read vector hi. Total 7 cycles before first
// handler instruction byte is fetched.
{
  const { cpu } = makeCpuWithIrqVector();
  cpu.setIrqLine(true);
  cpu.sampledIrq = true;
  // IRQ has already been sampled at the previous instruction boundary, so
  // the next clock begins IRQ entry rather than fetching the NOP at $0400.
  for (let i = 0; i < 7; i++) cpu.clock();
  // At end of 7 cycles, PC should equal handler vector.
  expect(cpu.pc === 0x9000,
    `after 7 IRQ-entry cycles, PC must = $9000, got $${cpu.pc.toString(16)}`);
  ok('6510 IRQ entry takes exactly 7 cycles to load PC from vector');
}

// ── 2: I flag is set during IRQ entry ──────────────────────────────────
// Push P happens with the OLD I=0; after push, I is set to 1 so the
// handler runs with interrupts disabled.
{
  const { cpu, mem } = makeCpuWithIrqVector();
  cpu.setIrqLine(true);
  cpu.sampledIrq = true;
  for (let i = 0; i < 7; i++) cpu.clock(); // IRQ entry
  expect(cpu.I === 1, `I flag must be set after IRQ entry, got I=${cpu.I}`);
  // Stack: SP = $FF after reset (VICE convention — see cpu.reset). After 3
  // IRQ pushes (PCH→$01FF, PCL→$01FE, P→$01FD): SP=$FC.
  expect(cpu.sp === 0xFC, `SP should be $FC after 3 pushes, got $${cpu.sp.toString(16)}`);
  const pushedP = mem.ram[0x01FD];
  expect((pushedP & 0x10) === 0, `pushed P: B flag must be CLEAR for IRQ, got B=${(pushedP >> 4) & 1}`);
  expect((pushedP & 0x04) === 0, `pushed P: original I=0 must be on the stack, got I=${(pushedP >> 2) & 1}`);
  ok('IRQ entry sets I=1 and pushes P with B=0 (distinguishes from BRK)');
}

// ── 3: IRQ asserted during last cycle of NOP recognized at end of NOP ──
// 6510 samples IRQ at phi2 of EVERY cycle (including the last). An IRQ
// asserted at the start of any cycle is recognized at the end of that
// instruction. Our impl samples in clock() before the micro-op runs,
// when cyclesRemaining > 0 — so the last cycle's sample IS taken.
//
// Fix 2026-05-03 (OrbitUntold investigation): previously this was
// `> 1`, which delayed IRQ recognition by one instruction whenever IRQ
// asserted during the last cycle. Caused OrbitUntold's CIA1-timer IRQ
// to be off-by-one-instruction relative to VICE.
{
  const { cpu, mem } = makeCpuWithIrqVector();
  // Vector points at $9000; load a known sentinel (LDA #$77 / BRK) so we
  // can assert "IRQ entered" by checking PC reached $9002 after BRK.
  mem.ram[0x9000] = 0xEA;               // NOP at handler entry
  mem.ram[0x9001] = 0xEA;
  expect(cpu.irqLine === false, `pre-state: IRQ line must be low`);
  cpu.clock();                          // NOP cycle 1
  cpu.setIrqLine(true);                 // IRQ asserts mid-instruction
  cpu.clock();                          // NOP cycle 2 (last) — sampled, sampledIrq=true
  // Next clock should _beginInstruction with sampledIrq true → IRQ entry.
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `IRQ recognized at last-cycle assertion, PC=$${cpu.pc.toString(16)}`);
  ok('6510 IRQ sampling: last-cycle assertion is detected (rem > 0)');
}

// ── 4: I=1 blocks IRQ entry until I is cleared ────────────────────────
// While the I flag is set, irqLine assertion is ignored. Clearing I
// (via CLI/PLP/RTI) takes effect after a 1-instruction shadow.
{
  const { cpu } = makeCpuWithIrqVector();
  cpu.I = 1; cpu._pollI = 1;                            // disable IRQs
  cpu.setIrqLine(true);
  cpu.clock(); cpu.clock();             // run a NOP — IRQ ignored
  cpu.clock(); cpu.clock();             // another NOP — still ignored
  expect(cpu.pc !== 0x9000,
    `IRQ must NOT enter while I=1, but PC=$${cpu.pc.toString(16)}`);
  expect(cpu.pc === 0x0402,
    `PC should advance through 2 NOPs to $0402, got $${cpu.pc.toString(16)}`);
  ok('6510: IRQ blocked while I=1');
}

// ── 5: IRQ pushes return address pointing to next instruction ─────────
// After IRQ entry, the pushed PC should point to the next instruction
// after the one that was running when IRQ was recognized.
{
  const { cpu, mem } = makeCpuWithIrqVector();
  cpu.clock(); cpu.clock();             // NOP at $0400 completes
  cpu.setIrqLine(true);
  cpu.sampledIrq = true;                // IRQ sampled during the completed instruction
  // Now CPU is at instruction boundary. PC = $0401. IRQ entry should push $0401.
  for (let i = 0; i < 7; i++) cpu.clock();
  // SP = $FF (post-reset). 3 pushes → SP=$FC.
  // Pushed: PCH at $01FF, PCL at $01FE, P at $01FD.
  const retLo = mem.ram[0x01FE];
  const retHi = mem.ram[0x01FF];
  const ret = retLo | (retHi << 8);
  expect(ret === 0x0401,
    `pushed return address must be $0401 (next instruction), got $${ret.toString(16)}`);
  ok('6510 IRQ pushes PC of NEXT instruction (post-completion of current)');
}

// ── 6: IRQ vector read from $FFFE/$FFFF ────────────────────────────────
// 6510 reads the IRQ vector from $FFFE (low) / $FFFF (high). Some
// emulators get this wrong by reading $FFFA (NMI) or $FFFC (RESET).
{
  const { cpu, mem } = makeCpuWithIrqVector(0xAB, 0xCD);
  // Sentinel: write distinct values to other vectors to detect misroute.
  mem.ram[0xFFFA] = 0x11; mem.ram[0xFFFB] = 0x22;  // NMI
  mem.ram[0xFFFC] = 0x33; mem.ram[0xFFFD] = 0x44;  // RESET (already used at reset; reset already happened)
  cpu.setIrqLine(true);
  cpu.sampledIrq = true;
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0xCDAB,
    `IRQ vector must be read from $FFFE/$FFFF (= $CDAB), got $${cpu.pc.toString(16)}`);
  ok('6510 IRQ reads vector from $FFFE/$FFFF (not NMI or RESET)');
}

// ── 7: VIC raster IRQ fires at cycle 1 of target raster ────────────────
// Bauer §3.12: raster compare evaluates at cycle 1 of every line (cycle 2
// for raster 0). When raster matches D012/D011-bit-7 and IRQ mask bit 0
// is set, $D019 bit 0 latches and the CPU IRQ line is asserted.
{
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  let asserted = false, assertCycle = -1, assertRaster = -1;
  vic.irqHandler = (state) => {
    if (state && !asserted) {
      asserted = true;
      assertCycle = vic.cycleInLine;
      assertRaster = vic.raster;
    }
  };
  vic.regs[0x12] = 100;                 // raster compare = 100
  vic.regs[0x1A] = 0x01;                // raster IRQ enabled
  vic.irqMask = 0x01;
  // Drive past line 99 → into line 100.
  let safety = 200000;
  while (--safety && !asserted) vic.clock(1);
  expect(asserted, `raster IRQ must assert by line 100, but never fired`);
  expect(assertRaster === 100,
    `raster IRQ must assert at raster 100, fired at ${assertRaster}`);
  expect(assertCycle === 1,
    `raster IRQ must assert at cycle 1 (Bauer §3.12), fired at cycle ${assertCycle}`);
  ok('Bauer §3.12: VIC raster IRQ fires at cycle 1 of target raster');
}

// ── 8: VIC raster compare for raster 0 fires at cycle 2 ───────────────
// Bauer §3.12 footnote: the raster=0 compare is delayed by one cycle to
// avoid a race with the line-end transition.
{
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  let assertCycle = -1, assertRaster = -1, asserted = false;
  vic.irqHandler = (state) => {
    if (state && !asserted) {
      asserted = true;
      assertCycle = vic.cycleInLine;
      assertRaster = vic.raster;
    }
  };
  vic.regs[0x12] = 0;                   // raster compare = 0
  vic.regs[0x1A] = 0x01;
  vic.irqMask = 0x01;
  // Drive a full frame (312 lines × 64 cycles ≈ 20000 cycles) from line 1.
  // Skip line 0 first by clocking one full line so we start fresh.
  vic.raster = 1;                        // begin at line 1
  let safety = 200000;
  while (--safety && !asserted) vic.clock(1);
  expect(assertRaster === 0,
    `raster=0 IRQ must assert at raster 0, fired at ${assertRaster}`);
  expect(assertCycle === 2,
    `raster=0 IRQ must assert at cycle 2 (special case), fired at ${assertCycle}`);
  ok('Bauer §3.12: raster-0 IRQ delayed by 1 cycle (fires at cycle 2)');
}

// ── 9: nine.prg-style end-to-end: assert IRQ at known cycle, measure ──
// Build a program at $9000 that immediately writes $42 to $0500, so we
// can detect "first handler instruction executed". Pre-position CPU at
// instruction boundary, assert IRQ, count cycles to handler-side write.
{
  const mem = new FlatMemory();
  // Main loop at $0400: 4 NOPs (instruction boundaries every 2 cycles).
  mem.ram[0x0400] = 0xEA; mem.ram[0x0401] = 0xEA;
  mem.ram[0x0402] = 0xEA; mem.ram[0x0403] = 0xEA;
  // Handler at $9000: STA $0500 (4 cycles abs). A holds $42.
  mem.ram[0x9000] = 0x8D; mem.ram[0x9001] = 0x00; mem.ram[0x9002] = 0x05;
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  // Consume the 7-cycle reset-boot sequence so we start measuring from
  // the first user instruction boundary.
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 0; cpu._pollI = 0;
  cpu.a = 0x42;
  // Assert IRQ at the START of the very first instruction (opcode boundary).
  cpu.setIrqLine(true);
  let cycles = 0;
  // The first NOP runs and samples the live IRQ pin, then IRQ entry
  // (7 cycles), then STA absolute (4 cycles). Total 13 cycles to write
  // $42 to $0500.
  // After STA's 3rd cycle, the write occurs. After 4th cycle, instruction
  // is done.
  while (mem.ram[0x0500] !== 0x42 && cycles < 50) {
    cpu.clock();
    cycles++;
  }
  expect(mem.ram[0x0500] === 0x42, `handler never wrote sentinel`);
  // Expected: 2 (NOP) + 7 (IRQ) + 4 (STA abs) = 13 cycles total. The store
  // bus access happens on the 4th cycle of STA absolute; the cycle counter
  // here counts clock() calls, so `cycles` = 13.
  expect(cycles === 13,
    `IRQ→first-handler-write latency: expected 13 clocks (2 NOP + 7 entry + 4 STA abs), got ${cycles}`);
  ok('end-to-end IRQ latency: 2 NOP + 7 entry + 4 STA abs = 13 CPU cycles');
}

// ── 10: integrated VIC raster-IRQ → CPU handler latency ────────────────
// Couple a CPU and VIC like the real machine: VIC clocks first, asserts
// irqLine, CPU runs one cycle. Measure cycles from raster-IRQ assertion
// (line 100 cycle 1) to CPU writing a sentinel from the handler.
{
  const mem = new FlatMemory();
  // Main loop at $0400: NOP NOP JMP $0400 — runs forever without falling off.
  mem.ram[0x0400] = 0xEA; mem.ram[0x0401] = 0xEA;
  mem.ram[0x0402] = 0x4C; mem.ram[0x0403] = 0x00; mem.ram[0x0404] = 0x04;
  // Handler at $9000: STA $0500 (sentinel). A=$77.
  mem.ram[0x9000] = 0x8D; mem.ram[0x9001] = 0x00; mem.ram[0x9002] = 0x05;
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  cpu.I = 0; cpu._pollI = 0;
  cpu.a = 0x77;
  const vic = new VIC2();
  vic.ram = mem.ram;
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.regs[0x12] = 100;
  vic.regs[0x1A] = 0x01;
  vic.irqMask = 0x01;
  vic.irqHandler = (state) => cpu.setIrqLine(!!state);

  // Drive integrated. VIC.clock(1) per CPU.clock().
  let assertedCycle = -1, sentinelCycle = -1, totalCycles = 0;
  for (let i = 0; i < 50000; i++) {
    vic.clock(1);
    if (assertedCycle < 0 && cpu.irqLine) assertedCycle = totalCycles;
    cpu.clock();
    totalCycles++;
    if (mem.ram[0x0500] === 0x77 && sentinelCycle < 0) {
      sentinelCycle = totalCycles;
      break;
    }
  }
  expect(assertedCycle >= 0, `VIC never asserted IRQ line`);
  expect(sentinelCycle >= 0, `handler never wrote sentinel`);
  // From IRQ assertion to handler write: best case ~8 cycles (IRQ caught at
  // start of 2-cycle NOP → 1 remaining + 7 entry + 3 of STA abs = 11), worst
  // case ~16 (3-cycle JMP completing + 7 + 3 = 13, plus a 1-cycle slop
  // from sampling). The exact number tells us the cycle delta the demo sees.
  const latency = sentinelCycle - assertedCycle;
  expect(latency >= 8 && latency <= 17,
    `integrated IRQ-to-handler-write latency must be 8-17 cycles, got ${latency}`);
  ok(`integrated VIC→CPU latency = ${latency} cycles (8-17 spec-compliant)`);
}

console.log(`\n${testNo} IRQ-entry-latency spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
