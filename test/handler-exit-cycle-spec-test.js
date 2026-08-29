// VIC-level handler-exit cycle characterization test.
//
// Mirrors the 3AD demo's exact sprite-DMA chain across a sprite-display
// raster boundary and characterizes how the handler-path cycle count
// varies with entry phase. Two purposes:
//
//   1. Lock current behavior: the handler-path cycle count is a
//      deterministic function of entry phase (no non-determinism).
//   2. Document the K-sweep pattern so we have a baseline to compare
//      against VICE — and so any future change to BA/AEC/RMW timing
//      surfaces here loudly.
//
// Setup: full C64Machine with sp0-7 enabled, sp0-6 at Y=9, sp7 at Y=0,
// display off (D011=0). Inject CPU into the 3AD handler prelude at $C20E
// at varying line-cycle phases and measure the path to first STA $D020
// at $C06B (boundary).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { C64Machine } from '../src/machine.js';
import { CYCLES_PER_LINE } from '../src/vic2.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

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

function makeMachine() {
  const m = new C64Machine();
  m.loadROMs({
    kernal:  fs.readFileSync(path.join(repoRoot, 'roms/kernal.bin')),
    basic:   fs.readFileSync(path.join(repoRoot, 'roms/basic.bin')),
    charRom: fs.readFileSync(path.join(repoRoot, 'roms/chargen.bin')),
  });
  for (let i = 0; i < 60; i++) m.runFrame();
  return m;
}

function installHandler(ram) {
  const set = (addr, ...bytes) => bytes.forEach((b, i) => ram[addr+i] = b & 0xFF);
  set(0xC20E, 0xEE, 0xFF, 0xCF);                // INC $CFFF
  set(0xC211, 0xCE, 0xFF, 0xCF);                // DEC $CFFF
  set(0xC214, 0xA5, 0xF7);                      // LDA $F7
  set(0xC216, 0x8D, 0x1B, 0xC2);                // STA $C21B
  set(0xC219, 0xEA);                            // NOP
  set(0xC21A, 0x50, 0x00);                      // BVC $C21C
  set(0xC21C, 0xC9, 0xC9);                      // CMP #$C9
  set(0xC21E, 0xC9, 0xC9);                      // CMP #$C9
  set(0xC220, 0x24, 0xEA);                      // BIT $EA
  set(0xC222, 0xA2, 0x03);                      // LDX #$03
  set(0xC224, 0xCA);                            // DEX
  set(0xC225, 0xD0, 0xFD);                      // BNE $C224
  set(0xC227, 0xEE, 0x6C, 0xC2);                // INC $C26C
  set(0xC22A, 0x20, 0x66, 0xC0);                // JSR $C066
  set(0xC22D, 0x60);
  set(0xC066, 0xA0, 0x12);                      // LDY #$12
  set(0xC068, 0xB9, 0x8C, 0xCF);                // LDA $CF8C,Y
  set(0xC06B, 0x8D, 0x20, 0xD0);                // STA $D020
  set(0xC06E, 0x60);
  for (let i = 0; i < 0x20; i++) ram[0xCF8C + i] = 0x01 + (i & 0x0F);
  ram[0xF7] = 0;
}

function setupDemoSprites(m) {
  const v = m.vic2;
  v.regs[0x15] = 0xFF;
  v.regs[0x10] = 0x60;
  v.regs[0x17] = 0x00;
  v.regs[0x11] = 0x00;
  const xs = [24, 72, 120, 168, 216, 8, 56, 0];
  const ys = [ 9,  9,  9,   9,   9, 9,  9, 0];
  for (let s = 0; s < 8; s++) { v.regs[s*2] = xs[s]; v.regs[s*2+1] = ys[s]; }
  const cyclesPerFrame = CYCLES_PER_LINE * 312;
  for (let i = 0; i < cyclesPerFrame * 3; i++) v.clock(1);
}

function measureHandlerPath(R, K) {
  const m = makeMachine();
  installHandler(m.mem.ram);
  setupDemoSprites(m);
  const v = m.vic2, cpu = m.cpu;
  while (!(v.raster === R && v.cycleInLine === K)) {
    m._runMasterCycle();
    if (v.totalCycles > 10_000_000) throw new Error('runaway');
  }
  cpu.pc = 0xC20E;
  cpu.I = 1;
  cpu.V = 0;
  cpu.sampledIrq = false;
  cpu.sampledIrqPrev = false;
  cpu.instructionCyclesRemaining = 0;
  const entryCy = v.totalCycles;
  for (let i = 0; i < 500; i++) {
    m._runMasterCycle();
    if (cpu.pc === 0xC06B && cpu.atInstructionBoundary()) {
      return v.totalCycles - entryCy;
    }
  }
  return null;
}

const RASTER = 20;       // mid-display line (sp0-6 displayed, sp7 displayed too)

// ── 1: Handler-path cycle count is DETERMINISTIC for fixed inputs.
{
  const t1 = measureHandlerPath(RASTER, 49);
  const t2 = measureHandlerPath(RASTER, 49);
  expect(t1 === t2, `must be deterministic: got ${t1} vs ${t2}`);
  console.log(`     K=49 reproducibility: run1=${t1}, run2=${t2}`);
  ok('deterministic handler-path cycle count for fixed VIC + sprite state');
}

// ── 2: K-sweep snapshot. Capture the cycle count for K=46..56 so any
// future change to BA/AEC/RMW or sprite-DMA timing surfaces as a diff
// here. We don't assert monotonicity — Bauer §3.6.1 + §3.8.1 doesn't
// require it (the path length can jump when entry-phase causes a stall
// to land on a different instruction's cycle). What we DO lock are the
// concrete values our impl produces at the AEC-fix baseline.
{
  const observed = {};
  for (const K of [46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]) {
    observed[K] = measureHandlerPath(RASTER, K);
  }
  console.log('     K-sweep:', Object.entries(observed)
    .map(([k,v]) => `K${k}=${v}`).join(' '));

  // Baseline values from the symmetric BA impl (with Bauer §3.12 mid-line
  // raster-IRQ firing). These are the canonical characterization values
  // for line R=20 (sp0-7 all DMA-on, both sprite-DMA windows on either
  // side of the line boundary intersect the handler path). If our BA /
  // AEC / RMW timing changes, any of these entries shifting indicates
  // either a fix or a regression — the test failure will say which K
  // shifted by how much, so we can diff against VICE and decide.
  //
  // Note: K=50→K=51 shows a +2 path jump (99→101). This is flagged for
  // VICE comparison in test 3 below — under strict Bauer §3.5 the step
  // is expected if INC abs read EA stalls on the first sprite-BA-low
  // cycle. A future model refinement (e.g., spec-derivable in-flight read
  // semantics) could smooth this.
  const baseline = {
    46: 100, 47: 99, 48: 101, 49: 100, 50: 99,
    51: 101, 52: 101, 53: 101, 54: 101, 55: 100, 56: 99,
  };
  for (const K of Object.keys(baseline)) {
    expect(observed[K] === baseline[K],
      `K=${K}: expected ${baseline[K]} cycles, got ${observed[K]} (Δ=${observed[K] - baseline[K]})`);
  }
  ok('K-sweep matches post-AEC-fix baseline (R=20 with sp0-7 DMA-on)');
}

// ── 3: Document the suspicious non-monotonicity at K=50→K=51 (FLAGGED).
//
// Empirically: K=50→99, K=51→101 — a +2 cycle path jump. In absolute
// terms, handler-end time goes K=50:149 → K=51:152, a +3 absolute-cycle
// shift for a +1 entry phase shift.
//
// Under strict Bauer §3.5 (symmetric BA) this step IS the expected
// signature of INC abs's read-EA stalling on the first sprite-BA-low
// cycle. The earlier split-asymmetric refinement smoothed this to -1
// but breaks FppScroller/Nine visually, so symmetric is the chosen
// model. This test LOCKS the +2 jump so any future smoothing (or a
// regression introducing a larger jump) surfaces immediately.
{
  const k50 = measureHandlerPath(RASTER, 50);
  const k51 = measureHandlerPath(RASTER, 51);
  const diff = k51 - k50;
  console.log(`     K=50→${k50}, K=51→${k51}, Δpath=${diff}, Δabs=${(51+k51)-(50+k50)}`);
  expect(diff === 2,
    `symmetric BA: K=50→K=51 +2 path-length step (INC abs read-EA stalls on first BA-low cycle). Got Δ=${diff}`);
  ok('K=50→K=51 path step locked at +2 cycles under symmetric BA (FLAGGED for VICE comparison)');
}

console.log(`\n${testNo} handler-exit cycle characterization tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
