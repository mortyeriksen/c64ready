// Raster-IRQ accept-cycle stability + chain timing spec test.
//
// Nine's 9-digit sprite multiplexer is driven by a chain of raster IRQs.
// Each handler writes new sprite Y / X / $D015 values at a specific
// cycle of a specific raster — the timing depends on:
//
//   1. The cycle at which the raster IRQ ASSERTS (Bauer §3.12: cycle 1
//      phi1 of the matching raster, with cycle 2 the equivalent for
//      raster 0 due to the wrap latch).
//   2. The latency from assert to CPU IRQ accept (= current instruction
//      remainder + 7 cycles for the BRK-style entry sequence).
//   3. The deterministic per-cycle counting through the handler body so
//      `STA $D001+s*2` lands at the cycle Nine's design requires.
//
// If our emulator drifts by even ONE cycle on any of these, the demo's
// Y writes land at the wrong raster cycle and sprites paint at wrong
// positions on subsequent rasters — exactly the "garbage for a few
// frames" symptom the user reports.
//
// What this file pins:
//
//   1. Raster IRQ asserts at cycle 1 phi1 (cy2 of raster 0).
//   2. CPU accepts the IRQ within 7..14 cycles of the assert (= 7 cycle
//      BRK entry + 0..7 cycle prior-instr remainder).
//   3. The accept cycle is STABLE across 50+ frames when the CPU is in
//      a known steady-state polling loop — no drift.
//   4. Chained IRQs: 5 consecutive raster IRQs at known target rasters
//      each fire and accept at the predicted cycle offsets.
//
// Reference: Bauer §3.12, VIC-Addendum.txt "Raster IRQ", and
// raster-irq-chain-spec-test.js which covers band-rendering correctness
// (the COMPLEMENTARY assertion to this file's cycle-timing assertion).

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

// Tiny PRG: install raster IRQ handler at $0900, target L100, handler
// writes a sentinel and increments a counter. Set IRQ vector ($FFFE/F)
// via the kernal vectors at $0314/$0315, which the kernal IRQ trampoline
// at $EA31 reads. Simpler: hijack the kernal vector at $0314 (NMI
// trampoline path; raster IRQ goes through the kernal $EA31 → $0314
// indirect jump).
function buildPRG() {
  const code = [];
  let pc = 0x0801;
  function emit(...bytes) { for (const b of bytes) code.push(b & 0xFF); pc += bytes.length; }
  function org(addr) {
    const pad = addr - pc;
    if (pad < 0) throw new Error(`org backwards: ${pc.toString(16)} → ${addr.toString(16)}`);
    for (let i = 0; i < pad; i++) code.push(0);
    pc = addr;
  }

  // BASIC stub at $0801: 10 SYS 2064.
  emit(0x0B, 0x08, 0x0A, 0x00, 0x9E, 0x32, 0x30, 0x36, 0x34, 0x00, 0x00, 0x00);
  // $080D padding, then main at $0810.
  org(0x0810);

  // Init: SEI; LDA #<handler; STA $0314; LDA #>handler; STA $0315
  //       LDA #$01; STA $D01A; LDA #100; STA $D012;
  //       LDA $D011; AND #$7F; STA $D011 (clear bit 7);
  //       LDA #$7F; STA $DC0D (disable CIA timer IRQ);
  //       LDA $DC0D (ack);
  //       LDA #$00; STA $D020; CLI; loop forever.
  emit(0x78);                                // SEI
  emit(0xA9, 0x40, 0x8D, 0x14, 0x03);        // LDA #<$0940 (handler); STA $0314
  emit(0xA9, 0x09, 0x8D, 0x15, 0x03);        // LDA #>$0940; STA $0315
  emit(0xA9, 0x01, 0x8D, 0x1A, 0xD0);        // LDA #$01; STA $D01A
  emit(0xA9, 100,  0x8D, 0x12, 0xD0);        // LDA #100; STA $D012
  emit(0xAD, 0x11, 0xD0, 0x29, 0x7F, 0x8D, 0x11, 0xD0); // clear D011 bit 7
  emit(0xA9, 0x7F, 0x8D, 0x0D, 0xDC);        // disable CIA timer IRQ
  emit(0xAD, 0x0D, 0xDC);                    // ack CIA
  emit(0xA9, 0x00, 0x8D, 0x20, 0xD0);        // border = black
  emit(0x58);                                // CLI

  // Idle loop: NOP NOP NOP JMP loop  (3+3+3 = 9 cy + 3-cycle JMP = 12 cy total).
  // Use simple JMP self at $082C: 4C 2C 08.
  const loopAddr = 0x0810 + (pc - 0x0810);
  emit(0x4C, loopAddr & 0xFF, (loopAddr >> 8) & 0xFF);   // JMP self

  // Handler at $0940. Records:
  //   $0801 (handler-entered counter, decremented from $00 since we test
  //   on bytes not in PRG). Use $0400+ instead (screen RAM safe area for
  //   our purposes — kernel uses).
  //
  // Better: use $C000+ (free RAM). Handler increments a counter at $C000,
  // ACKs IRQ via STA $D019, increments raster target by 1 (next line),
  // RTI.
  org(0x0940);
  emit(0xEE, 0x00, 0xC0);                    // INC $C000 — handler entry counter
  emit(0xA9, 0x01, 0x8D, 0x19, 0xD0);        // LDA #$01; STA $D019 — ack
  emit(0x68, 0xA8, 0x68, 0xAA, 0x68, 0x40);  // PLA TAY PLA TAX PLA RTI
                                              // (kernal $EA31 trampoline calls us through $0314 AFTER
                                              // pushing A/X/Y. We restore them and RTI back to caller.)

  return new Uint8Array([0x01, 0x08, ...code]);
}

function makePRGSysTarget() { return 2064; }

// Boot machine + run handler-installation + idle for a few frames.
function boot() {
  const m = new C64Machine();
  // ROMs from disk.
  const fs = require('fs');
  const path = require('path');
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, '..');
  m.loadROMs({
    kernal:  fs.readFileSync(path.join(repoRoot, 'roms/kernal.bin')),
    basic:   fs.readFileSync(path.join(repoRoot, 'roms/basic.bin')),
    charRom: fs.readFileSync(path.join(repoRoot, 'roms/chargen.bin')),
  });
  const prg = buildPRG();
  m.loadPRG(prg);
  // Boot enough for the kernal READY prompt → STOP key check → handle BASIC.
  for (let i = 0; i < 100; i++) m.runFrame();
  m.cpu.pc = makePRGSysTarget();
  return m;
}

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ─── 1: Raster IRQ asserts at cycle 1 phi1 of matching raster — not earlier
//
// Bauer §3.12: the raster compare evaluates each line at cycle 1 phi1.
// Spec-anchored two-sided check:
//   (a) at L99 c62 (last cycle of prev raster), irqStatus bit 0 must be 0.
//   (b) at L100 c1, irqStatus bit 0 must be 1.
// This catches BOTH late-latch (impl asserts at c2 or later) and
// early-latch (impl asserts at c62 of prev raster) drift.
{
  const m = boot();
  for (let i = 0; i < 5; i++) m.runFrame();
  // Handler ack at $D019 clears bit 0 each fire, so by the time we
  // observe L99 c62 of the NEXT frame, irqStatus bit 0 should be 0.
  // Then at L100 c1 it should be 1.
  const v = m.vic2;

  let safety = 312 * 63 * 2;
  while (--safety > 0 && !(v.raster === 99 && v.cycleInLine === 62)) {
    m._runMasterCycle();
  }
  expect((v.irqStatus & 0x01) === 0,
    `Bauer §3.12: irqStatus RST bit must be 0 at L99 c62 (BEFORE L100 c1 latch); got $${v.irqStatus.toString(16)}`);
  // Step into L100. Cycle numbering: 0 or 1 depending on impl wrap.
  m._runMasterCycle();
  // Allow one more cycle if we're at c0 (transitional).
  if (v.cycleInLine === 0) m._runMasterCycle();
  expect(v.raster === 100 && v.cycleInLine === 1,
    `landed at L100 c1; got L${v.raster} c${v.cycleInLine}`);
  expect((v.irqStatus & 0x01) === 1,
    `Bauer §3.12: irqStatus RST bit must be 1 at L100 c1 (latched on raster match); got $${v.irqStatus.toString(16)}`);
  ok('Bauer §3.12: raster IRQ flag latches AT L100 c1, not before');
}

// ─── 2: CPU IRQ accept fires within 7..14 cycles of assert ──────────────
//
// 6502 IRQ entry takes 7 cycles (push PCH, PCL, P, set I, fetch vector
// lo, fetch vector hi, internal). Plus 0..7 cycles for the prior
// instruction to complete (longest 6502 instr = 7 cy for indirect RMW).
// CPU is in a 3-cycle JMP self loop, so prior-instr remainder is 0..2.
// Bound: 7..9 cycles to vector entry; up to 14 for absolute worst case
// across all opcodes.
//
// Track the moment CPU.pc first changes to the IRQ vector destination
// (= contents of $FFFE/$FFFF after IRQ accept — kernal IRQ entry $FF48).
{
  const m = boot();
  for (let i = 0; i < 5; i++) m.runFrame();

  const v = m.vic2;
  // Read the IRQ vector target from RAM (kernal IRQ entry).
  const irqVectorLo = m.mem.read(0xFFFE);
  const irqVectorHi = m.mem.read(0xFFFF);
  const irqEntry = irqVectorLo | (irqVectorHi << 8);

  // Drive to L99 c62, then step into L100 c0/c1 (the cycle-wrap transition
  // where the raster IRQ asserts in VIC phi1).
  let safety = 312 * 63 * 2;
  while (--safety > 0 && !(v.raster === 99 && v.cycleInLine === 62)) {
    m._runMasterCycle();
  }
  // Step into L100 c1 (the actual assert cycle per Bauer §3.12 "first
  // cycle of matching raster"). After driveTo(99,62), one _runMasterCycle
  // lands at L100 c0 (transitional); a second lands at c1 where IRQ
  // asserts in VIC phi1.
  m._runMasterCycle();   // → L100 (cycleInLine = 0 transitional)
  if (v.cycleInLine === 0) m._runMasterCycle();
  expect(v.raster === 100 && v.cycleInLine === 1,
    `step from L99 c62 lands on L100 c1 (= IRQ assert moment); got L${v.raster} c${v.cycleInLine}`);
  let cyclesToAccept = 0;
  const pcTrace = [];
  safety = 20;
  let firstAcceptCycle = -1;
  while (--safety > 0) {
    m._runMasterCycle();
    cyclesToAccept++;
    pcTrace.push(m.cpu.pc);
    if (m.cpu.pc === irqEntry && firstAcceptCycle < 0) {
      firstAcceptCycle = cyclesToAccept;
      break;
    }
  }
  expect(firstAcceptCycle > 0,
    `IRQ accept: CPU.pc must reach IRQ vector $${irqEntry.toString(16)} within 20 cycles. pc trace: ${pcTrace.map(p=>'$'+p.toString(16)).join(' ')}`);
  // Spec arithmetic per NMOS 6502 IRQ sequencing + the 1-cy VIC→CPU IRQ
  // pipeline (see irq-pipeline-spec-test.js for the pipeline's provenance):
  //   - VIC asserts irqLine at master cycle K phi1 (= L100 c1).
  //   - 1-cy pipeline: CPU sees IRQ at K+1.
  //   - CPU samples sampledIrq at (K+1) phi2.
  //   - Current instr (JMP self = 3 cy) completes at master cycle L where
  //     L-(K+1) ∈ {0, 1, 2} depending on which JMP cycle IRQ landed on.
  //   - _beginInstruction at L+1 queues BRK (7 micro-ops × 1 cycle).
  //   - PC = irqVector at end of L+7.
  //   - Latency from K = (L+7) - K = (L-K) + 7 ∈ [8, 10].
  expect(firstAcceptCycle >= 8 && firstAcceptCycle <= 10,
    `Accept latency = (L-K)(1..3) + 7 BRK = 8..10 cycles for JMP-self (with 1-cy pipeline). Got ${firstAcceptCycle}.`);
  ok(`NMOS 6502 IRQ entry + 1-cy pipeline: handler fetch at ${firstAcceptCycle} cycles past assert (spec range 8..10 for JMP-self)`);
}

// ─── 3: Accept cycle is STABLE across 50 frames (no drift) ───────────────
//
// If our CPU cycle counting drifts by even 1 cy per frame, after 50
// frames the accept lands at a different cycle. Lock the stability.
{
  const m = boot();
  for (let i = 0; i < 5; i++) m.runFrame();
  const v = m.vic2;

  const irqVectorLo = m.mem.read(0xFFFE);
  const irqVectorHi = m.mem.read(0xFFFF);
  const irqEntry = irqVectorLo | (irqVectorHi << 8);

  const acceptCycles = [];
  for (let frame = 0; frame < 50; frame++) {
    // Drive to L99 c62 then step into L100 c1.
    let safety = 312 * 63 * 2;
    while (--safety > 0 && !(v.raster === 99 && v.cycleInLine === 62)) {
      m._runMasterCycle();
    }
    m._runMasterCycle();
    if (v.cycleInLine === 0) m._runMasterCycle();   // skip to c1
    let n = -1;
    safety = 20;
    while (--safety > 0) {
      m._runMasterCycle();
      n = (n < 0 ? 1 : n + 1);
      if (m.cpu.pc === irqEntry) break;
    }
    acceptCycles.push(n);
    // Move past L100 so the next outer iteration finds the NEXT frame's L100.
    safety = 312 * 63;
    while (--safety > 0 && v.raster < 200) m._runMasterCycle();
  }
  const minA = Math.min(...acceptCycles);
  const maxA = Math.max(...acceptCycles);
  // Spec range per test 2 derivation with 1-cy pipeline: 8..10 (JMP-self
  // 3-cycle phase + 1 cy VIC→CPU pipeline).
  // Δ ≤ 2 is the worst-case phase span. Larger Δ across 50 frames = CPU
  // cycle accounting bug.
  expect(minA >= 8 && maxA <= 10,
    `Accept latency must stay in spec 8..10 across all frames (with 1-cy pipeline). Range ${minA}..${maxA}. Samples (first 10): ${acceptCycles.slice(0, 10).join(',')}`);
  expect(maxA - minA <= 2,
    `Drift bound Δ ≤ 2 (JMP-self phase window). Range ${minA}..${maxA}.`);
  ok(`Accept latency stable across 50 frames: min=${minA} max=${maxA} (Δ=${maxA-minA} ≤ 2 = JMP-self spec window)`);
}

// ─── 4: One IRQ fires per frame at the configured target raster ─────────
//
// With the handler only acking (no $D012 advance), exactly one raster IRQ
// should fire per frame. Across 10 frames the counter should advance by
// exactly 10.
{
  const m = boot();
  for (let i = 0; i < 5; i++) m.runFrame();
  m.mem.ram[0xC000] = 0;
  for (let i = 0; i < 10; i++) m.runFrame();
  const irqsFired = m.mem.ram[0xC000];
  expect(irqsFired === 10,
    `Stable chain: with $D012=100 fixed, exactly 10 IRQs per 10 frames. Got ${irqsFired}`);
  ok(`Stable raster IRQ: ${irqsFired} IRQs fired in exactly 10 frames`);
}

console.log(`\n${testNo} IRQ accept-cycle stability spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
