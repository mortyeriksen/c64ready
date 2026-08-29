// Per-opcode raster IRQ accept-cycle spec test.
//
// Extends nine-irq-accept-cycle-spec-test.js (which covers only the JMP
// self-loop case) to verify spec-exact accept latency for each common
// main-loop opcode shape. Nine's main loop (between IRQ slots) does
// cycle-counted register/memory work — if our CPU's cycle accounting
// drifts for ANY of those opcodes, the demo's $D000+s*2 writes land at
// the wrong cycle and sprites paint misaligned.
//
// Spec arithmetic per NMOS 6502 + the 1-cy VIC→CPU IRQ pipeline (see
// irq-pipeline-spec-test.js for the pipeline's provenance):
//
//   - VIC asserts irqLine at cycle K phi1.
//   - 1-cy pipeline: CPU sees irqLine high at master cycle K+1.
//   - CPU samples sampledIrq at (K+1) phi2.
//   - At master cycle K+2 (if instr boundary reached) _beginInstruction
//     sees sampledIrq=true and queues BRK (7 micro-ops × 1 cycle each).
//   - BRK's first micro-op runs in the SAME cycle it's queued — so the
//     7 BRK cycles span K+2 .. K+8 (when instr ends exactly at K+1).
//
//   For an N-cycle current instruction:
//     - IRQ at instr's LAST cycle: instr done at K+1. BRK K+2..K+8.
//       Latency from K = 8.
//     - IRQ at instr's FIRST cycle: instr cycles 1..N run starting K+1.
//       _beginInstruction at K+1+N. BRK K+1+N..K+N+7. Latency = N+7.
//
//   ⇒ Per-instruction latency range = 8..(N+7).
//
//   For a LOOP body of repeated opcode I plus a trailing JMP self
//   (3 cycles), the worst case is `max(I_cycles, 3) + 7`.
//
// For each opcode tested, the assert lands at a random phase within the
// loop. Across many trials we expect to observe the full spec range,
// distinguishing impl-correct behavior from a drift that compresses
// (= IRQ samples late) or expands (= IRQ samples too eagerly) the range.
//
// Reference: nine-irq-accept-cycle-spec-test.js (JMP-self only); this
// file adds coverage for the opcodes nine's main loop actually uses.

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

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');

// Build a PRG whose idle loop is a configurable repeating instruction.
// Each test case specifies the body opcode bytes + cycle count.
function buildPRG(loopBodyBytes) {
  const code = [];
  let pc = 0x0801;
  function emit(...bytes) { for (const b of bytes) code.push(b & 0xFF); pc += bytes.length; }
  function org(addr) {
    const pad = addr - pc;
    for (let i = 0; i < pad; i++) code.push(0);
    pc = addr;
  }

  // BASIC stub: 10 SYS 2064.
  emit(0x0B, 0x08, 0x0A, 0x00, 0x9E, 0x32, 0x30, 0x36, 0x34, 0x00, 0x00, 0x00);
  org(0x0810);

  emit(0x78);                                  // SEI
  emit(0xA9, 0x40, 0x8D, 0x14, 0x03);          // LDA #<$0940; STA $0314
  emit(0xA9, 0x09, 0x8D, 0x15, 0x03);          // LDA #>$0940; STA $0315
  emit(0xA9, 0x01, 0x8D, 0x1A, 0xD0);          // LDA #$01; STA $D01A
  emit(0xA9, 100, 0x8D, 0x12, 0xD0);           // LDA #100; STA $D012
  emit(0xAD, 0x11, 0xD0, 0x29, 0x7F, 0x8D, 0x11, 0xD0); // D011 bit 7 = 0
  emit(0xA9, 0x7F, 0x8D, 0x0D, 0xDC);          // CIA1 timer IRQ off
  emit(0xAD, 0x0D, 0xDC);                      // ack CIA1
  emit(0xA9, 0x00, 0x8D, 0x20, 0xD0);          // D020 = 0
  emit(0x58);                                  // CLI

  // Loop body: tight repetition of `loopBodyBytes`. Use enough copies to
  // fill at least one raster line worth of cycles (~63), then JMP back.
  const loopStart = 0x0810 + (pc - 0x0810);
  // 30 copies should cover any single-cycle pattern.
  for (let i = 0; i < 30; i++) emit(...loopBodyBytes);
  emit(0x4C, loopStart & 0xFF, (loopStart >> 8) & 0xFF);    // JMP loopStart

  // Handler at $0940 — counter + ack + restore + RTI.
  org(0x0940);
  emit(0xEE, 0x00, 0xC0);                      // INC $C000
  emit(0xA9, 0x01, 0x8D, 0x19, 0xD0);          // LDA #$01; STA $D019
  emit(0x68, 0xA8, 0x68, 0xAA, 0x68, 0x40);    // PLA TAY PLA TAX PLA RTI

  return new Uint8Array([0x01, 0x08, ...code]);
}

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, '..');

function bootPRG(prg) {
  const m = new C64Machine();
  m.loadROMs({
    kernal:  fs.readFileSync(path.join(repoRoot, 'roms/kernal.bin')),
    basic:   fs.readFileSync(path.join(repoRoot, 'roms/basic.bin')),
    charRom: fs.readFileSync(path.join(repoRoot, 'roms/chargen.bin')),
  });
  m.loadPRG(prg);
  for (let i = 0; i < 100; i++) m.runFrame();
  m.cpu.pc = 2064;     // SYS target
  for (let i = 0; i < 5; i++) m.runFrame();
  return m;
}

// Measure accept latency across N raster-IRQ events. Returns array of
// per-event cycle counts. Each event is the count from "raster reaches
// 100 c1" to "PC reaches IRQ vector".
function measureAcceptLatencies(m, nEvents) {
  const v = m.vic2;
  const irqVectorLo = m.mem.read(0xFFFE);
  const irqVectorHi = m.mem.read(0xFFFF);
  const irqEntry = irqVectorLo | (irqVectorHi << 8);

  const latencies = [];
  for (let i = 0; i < nEvents; i++) {
    // Drive to L99 c62.
    let safety = 312 * 63 * 2;
    while (--safety > 0 && !(v.raster === 99 && v.cycleInLine === 62)) {
      m._runMasterCycle();
    }
    // Step into L100 (c0 or c1).
    m._runMasterCycle();
    if (v.cycleInLine === 0) m._runMasterCycle();
    // Now at L100 c1 (assert moment). Count cycles to IRQ entry.
    let n = 0;
    safety = 20;
    while (--safety > 0) {
      m._runMasterCycle();
      n++;
      if (m.cpu.pc === irqEntry) break;
    }
    latencies.push(n);
    // Move past L100 so next iteration finds the NEXT frame's L100.
    safety = 312 * 63;
    while (--safety > 0 && v.raster < 200) m._runMasterCycle();
  }
  return latencies;
}

// Each loop's body opcode is followed by a trailing `JMP loopStart`
// (3 cycles). With 1-cy pipeline: spec range = 8..(max(body_cycles, 3) + 7).

// ─── 1: NOP-only loop (body 2 cy, JMP 3 cy → max 3 → range 8..10)
{
  const m = bootPRG(buildPRG([0xEA]));   // NOP = 2 cy
  const lat = measureAcceptLatencies(m, 50);
  const min = Math.min(...lat), max = Math.max(...lat);
  expect(min >= 8 && max <= 10,
    `NOP+JMP loop: range must be 8..10 (with 1-cy pipeline). Got ${min}..${max}. Samples: ${lat.slice(0,10).join(',')}`);
  ok(`6502 IRQ spec + 1-cy pipeline: NOP+JMP loop → accept range ${min}..${max} (spec 8..10)`);
}

// ─── 2: LDA absolute loop (body 4 cy → range 8..11)
{
  const m = bootPRG(buildPRG([0xAD, 0x00, 0x04]));   // LDA $0400 (4 cy)
  const lat = measureAcceptLatencies(m, 50);
  const min = Math.min(...lat), max = Math.max(...lat);
  expect(min >= 8 && max <= 11,
    `LDA-abs+JMP loop: range must be 8..11 (with 1-cy pipeline). Got ${min}..${max}. Samples: ${lat.slice(0,10).join(',')}`);
  ok(`6502 IRQ spec + 1-cy pipeline: LDA absolute loop → accept range ${min}..${max} (spec 8..11)`);
}

// ─── 3: STA absolute loop (body 4 cy → range 8..11)
{
  const m = bootPRG(buildPRG([0x8D, 0x00, 0x04]));   // STA $0400 (4 cy)
  const lat = measureAcceptLatencies(m, 50);
  const min = Math.min(...lat), max = Math.max(...lat);
  expect(min >= 8 && max <= 11,
    `STA-abs+JMP loop: range must be 8..11 (with 1-cy pipeline). Got ${min}..${max}. Samples: ${lat.slice(0,10).join(',')}`);
  ok(`6502 IRQ spec + 1-cy pipeline: STA absolute loop → accept range ${min}..${max} (spec 8..11)`);
}

// ─── 4: INC absolute loop (body 6 cy RMW → range 8..13)
{
  const m = bootPRG(buildPRG([0xEE, 0x00, 0x04]));   // INC $0400 (6 cy)
  const lat = measureAcceptLatencies(m, 50);
  const min = Math.min(...lat), max = Math.max(...lat);
  expect(min >= 8 && max <= 13,
    `INC-abs+JMP loop: range must be 8..13 (with 1-cy pipeline). Got ${min}..${max}. Samples: ${lat.slice(0,10).join(',')}`);
  ok(`6502 IRQ spec + 1-cy pipeline: INC absolute loop → accept range ${min}..${max} (spec 8..13)`);
}

// ─── 5: Best-case latency MUST reach exactly 8 cycles ───────────────────
//
// Spec invariant: when IRQ asserts at the LAST cycle of any instruction,
// AFTER the 1-cy VIC→CPU pipeline, the next master cycle's
// _beginInstruction queues BRK; BRK takes 7 cycles. Latency from VIC
// source assertion = 1 (pipeline) + 7 (BRK) = 8.
//
// If our impl's min is ≥ 9, an EXTRA pipeline cycle has crept in. If
// min is ≤ 7, the pipeline is missing. Sample enough events to ensure
// we observe the best-case phase.
{
  const m = bootPRG(buildPRG([0xEA]));
  const lat = measureAcceptLatencies(m, 100);
  const minLat = Math.min(...lat);
  expect(minLat === 8,
    `Best-case latency must reach exactly 8 cycles (1-cy pipeline + BRK 7). Got min=${minLat}.`);
  ok(`6502 IRQ spec + 1-cy pipeline: best-case accept latency = 8 cycles`);
}

// ─── 6: Long-instruction-loop reaches max-range (INC-abs → 13) ──────────
//
// For an INC-abs loop, if IRQ asserts at INC cycle 1, the latency =
// 1 (pipeline) + 6 (INC) + 7 (BRK actually overlapping last cy) - wait
// derivation: from VIC source, IRQ takes 1 cy to reach CPU. Then current
// INC has cycles 1..6 remaining if IRQ landed at cy 0. Then BRK 7 cy.
// Max = 1 + 6 + 6 = 13. (BRK's last micro-op fires at boundary, so 6
// useful cycles to PC=vector.)
{
  const m = bootPRG(buildPRG([0xEE, 0x00, 0x04]));
  const lat = measureAcceptLatencies(m, 200);
  const maxLat = Math.max(...lat);
  expect(maxLat === 13,
    `Worst-case latency for INC-abs (6 cy) with 1-cy pipeline must reach 13. Got max=${maxLat}.`);
  ok(`6502 IRQ spec + 1-cy pipeline: INC-abs worst-case accept latency = 13 cycles`);
}

console.log(`\n${testNo} per-opcode IRQ accept-cycle spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
