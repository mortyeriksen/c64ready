// VIC-II: KERNAL IRQ-prelude integration (38-44 cycles)
// Extracted from vic2-test.js.

import fs from 'fs';
import {
  VIC2,
  CANVAS_W,
  CANVAS_H,
  CYCLES_PER_FRAME,
  CYCLES_PER_LINE,
  C64_PALETTE,
  C64Machine,
  paletteRgba,
  ACCESS_IDLE,
  ACCESS_REFRESH,
  ACCESS_C,
  ACCESS_G,
  assert,
  softAssert,
  makeVic,
  makeRenderSeg,
  fillSpriteLineState,
  fillOpaqueSpriteAcrossLine,
  clearLineBuffers,
  setupSpriteForRender,
  setMulticolorRegs,
  fillTextLineState,
  clearRenderedRow,
  firstForegroundX,
  lastForegroundX,
  runUntil,
  makeMasterCycleHarness,
} from './_vic2-helpers.js';

// ============================================================================
// KERNAL IRQ-prelude integration test (the article's "38-44 cycles").
//
// Article steps from VIC IRQ assertion → user IRQ code entry:
//   2 cycles  CPU notice latency
//   0..6      in-flight instruction completion (jitter)
//   7         interrupt sequence (push PC + P, vector load)
//   29        KERNAL IRQ handler (PHA TXA PHA TYA PHA TSX LDA AND BEQ JMP
//             through CINV at $0314)
//   ─────────
//   = 38..44 total cycles to user IRQ code entry.
//
// KERNAL-PRELUDE: time the KERNAL IRQ handler in isolation. Push a fake
// hardware-IRQ stack frame, set PC to the KERNAL's IRQ vector ($FFFE/$FFFF),
// run until PC reaches the CINV target, count cycles. The KERNAL ROM the
// project ships with may have a non-standard handler (some KERNAL variants
// start with JSR $FFEA before the canonical sequence) — we measure
// whatever it actually does and compare against the article's 29.
// ============================================================================
// KERNAL ROM is pinned to a known variant — the cycle counts below are
// derived from this exact file.
//   sha256: 83c60d47047d7beab8e5b7bf6f67f80daa088b7a6a27de0d7e016f6484042721
//   IRQ entry vector ($FFFE/$FFFF): $FF48
{
  const kernalRom = fs.readFileSync('roms/kernal.bin');
  const machine = new C64Machine();
  machine.loadROMs({
    kernal: kernalRom,
    basic:  fs.readFileSync('roms/basic.bin'),
    charRom: fs.readFileSync('roms/chargen.bin'),
  });

  // User IRQ vector at $C000 with a sentinel.
  machine.mem.ram[0xC000] = 0xA9;   // LDA #$42
  machine.mem.ram[0xC001] = 0x42;
  machine.mem.ram[0xC002] = 0x8D;   // STA $0400
  machine.mem.ram[0xC003] = 0x00;
  machine.mem.ram[0xC004] = 0x04;

  // Wire CINV at $0314/$0315 → $C000.
  machine.mem.ram[0x0314] = 0x00;
  machine.mem.ram[0x0315] = 0xC0;

  // Read the actual KERNAL IRQ entry from the hardware vector and pin it.
  const irqEntry = machine.mem.read(0xFFFE) | (machine.mem.read(0xFFFF) << 8);
  assert(irqEntry === 0xFF48,
    `KERNAL IRQ entry vector pinned at $FF48 (got $${irqEntry.toString(16).toUpperCase()}) — ROM swap?`);

  // Fake hardware-IRQ stack frame (3 bytes pushed: P, PCL, PCH; SP=$FC).
  machine.cpu.sp = 0xFC;
  machine.mem.ram[0x01FD] = 0x20;   // P with B=0 (hardware IRQ)
  machine.mem.ram[0x01FE] = 0x00;   // PCL
  machine.mem.ram[0x01FF] = 0x40;   // PCH ($4000)
  machine.cpu.I = 1;

  machine.cpu.pc = irqEntry;
  machine.cpu.instructionCyclesRemaining = 0;
  machine.cpu.microOps = null;
  machine.cpu.irqLine = false;
  machine.cpu.sampledIrq = false;

  // Step the CPU only — count cycles until pc reaches user vector $C000.
  let cycles = 0;
  while (machine.cpu.pc !== 0xC000 && cycles < 500) {
    machine.cpu.clock();
    cycles++;
  }
  assert(machine.cpu.pc === 0xC000,
    `KERNAL IRQ handler eventually reaches user vector $C000 (pc=$${machine.cpu.pc.toString(16).padStart(4,'0')} after ${cycles} cycles)`);
  // Article (bumbershootsoft): canonical handler is 29 cycles
  // (PHA TXA PHA TYA PHA TSX LDA $0101,X AND #$10 BEQ JMP ($0314)).
  // Our pinned KERNAL matches the article exactly — hard-assert.
  assert(cycles === 29,
    `KERNAL IRQ handler from $FF48 → CINV target takes 29 cycles per article (got ${cycles})`);
  console.log(`ok  - KERNAL-PRELUDE: KERNAL IRQ handler ($${irqEntry.toString(16).toUpperCase()}) → CINV target reached in ${cycles} cycles`);
}

// KERNAL-PRELUDE-2: end-to-end through C64Machine. Cause an actual VIC
// raster IRQ and measure cycles from VIC IRQ assertion to user-vector
// entry. This pins the article's full "38-44 cycles" prelude.
{
  const kernalRom = fs.readFileSync('roms/kernal.bin');
  const machine = new C64Machine();
  machine.loadROMs({
    kernal: kernalRom,
    basic:  fs.readFileSync('roms/basic.bin'),
    charRom: fs.readFileSync('roms/chargen.bin'),
  });
  // Boot the KERNAL until it reaches its idle loop. After ~30 frames
  // the BASIC prompt is up and the timer-IRQ handler is installed.
  for (let f = 0; f < 60; f++) machine.runFrame();

  // Park the CPU in a tight foreground loop ($4000: JMP $4000) and
  // make sure we are at an instruction boundary before installing
  // our hooks (otherwise pc-write is overridden by in-flight microops).
  while (machine.cpu.instructionCyclesRemaining !== 0) machine._runMasterCycle();
  machine.mem.ram[0x4000] = 0x4C;
  machine.mem.ram[0x4001] = 0x00;
  machine.mem.ram[0x4002] = 0x40;
  machine.cpu.pc = 0x4000;
  machine.cpu.microOps = null;
  machine.cpu.instructionCyclesRemaining = 0;
  // Clear stale interrupt-sampling state so the CPU doesn't immediately
  // service a phantom IRQ at the start of the loop.
  machine.cpu.sampledIrq = false;
  machine.cpu._pollI = machine.cpu.I;
  machine.cpu.irqLine = false;

  // Disable the CIA1 timer IRQ source so VIC raster IRQ is the only
  // hardware IRQ that can fire during the measurement.
  machine.mem.write(0xDC0D, 0x7F);     // clear all CIA1 IRQ enables
  machine.mem.read(0xDC0D);            // ack pending CIA1 latches
  // Set I=0 so IRQs are recognized.
  machine.cpu.I = 0;

  // Plant a user IRQ vector that writes a sentinel to $0400.
  machine.mem.ram[0xC000] = 0xA9;      // LDA #$42
  machine.mem.ram[0xC001] = 0x42;
  machine.mem.ram[0xC002] = 0x8D;      // STA $0400
  machine.mem.ram[0xC003] = 0x00;
  machine.mem.ram[0xC004] = 0x04;
  machine.mem.ram[0xC005] = 0x4C;      // JMP $EA81 (KERNAL IRQ exit)
  machine.mem.ram[0xC006] = 0x81;
  machine.mem.ram[0xC007] = 0xEA;
  machine.mem.ram[0x0314] = 0x00;
  machine.mem.ram[0x0315] = 0xC0;
  machine.mem.ram[0x0400] = 0x00;

  // Configure raster IRQ at line 200 (well past current).
  machine.mem.write(0xD01A, 0x01);
  machine.mem.write(0xD012, 0xC8);
  machine.mem.write(0xD011, machine.vic2.regs[0x11] & 0x7F);
  machine.mem.write(0xD019, 0x0F);     // ack any latched

  // Hook the VIC's irqHandler so we capture the exact cycle the IRQ pin
  // is first asserted — by then the KERNAL may have already acked $D019,
  // so polling irqStatus inside the loop is unreliable.
  let assertCycle = -1, userCycle = -1;
  let currentCycle = 0;
  const origHandler = machine.vic2.irqHandler;
  machine.vic2.irqHandler = (state) => {
    if (state && assertCycle < 0) assertCycle = currentCycle;
    origHandler.call(machine, state);
  };

  for (let i = 0; i < 200_000; i++) {
    currentCycle = i;
    machine._runMasterCycle();
    if (assertCycle >= 0 && machine.mem.ram[0x0400] === 0x42) {
      userCycle = i;
      break;
    }
  }

  assert(userCycle >= 0,
    `KERNAL-PRELUDE-2: user IRQ vector ran (assertCycle=${assertCycle}, userCycle=${userCycle}, pc=$${machine.cpu.pc.toString(16)})`);

  const prelude = userCycle - assertCycle;
  // Per Bauer §3.12 + bumbershootsoft article timing breakdown:
  //   1 cycle notice (VIC asserts at cycle 1 of target line, CPU samples
  //                   at end of that cycle for the NEXT instruction boundary)
  // + 0 cycles in-flight (CPU pinned at instruction boundary)
  // + 7 cycles IRQ entry sequence
  // + 29 cycles KERNAL IRQ handler ($FF48 → JMP ($0314))
  // + 2 cycles LDA #$42
  // + 4 cycles STA $0400
  // = 43 cycles total when every 6502 cycle participates in the bus/RDY
  // timing model.
  assert(prelude === 43,
    `IRQ-to-user-write deterministic on pinned KERNAL: 43 cycles (got ${prelude})`);
  console.log(`ok  - KERNAL-PRELUDE-2: VIC IRQ → STA $0400 in user IRQ vector took ${prelude} cycles`);
}

console.log('\nAll VIC-II tests passed.');

console.log('\nAll KERNAL IRQ-prelude integration (38-44 cycles) tests passed.');
