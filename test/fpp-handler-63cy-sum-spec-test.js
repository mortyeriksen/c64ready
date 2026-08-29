// FppScroller handler 63-master-cycle sum spec test.
//
// The FPP scroller's per-line handler is a STRAIGHT-LINE cycle-counted
// instruction sequence that must take EXACTLY 63 master cycles per
// iteration (= one PAL raster line). If any instruction in the sequence
// mis-counts by N cycles, the next iteration's register writes drift
// by N cycles within the line, accumulating to the visible -21..+42 cy
// drift the cycle-position test sees.
//
// This file replicates the EXACT instruction sequence from the FPP
// handler (decoded from the trace at raster $AF in frame 220 of the
// boot run) in a clean test rig, runs it from a known starting state
// with NO BA-stalls / NO bad-line interactions, and asserts the total
// master-cycle count equals 63.
//
// The sequence (17 instructions, replicated at $1000+):
//
//   STX $DD02   (4 cy)  ; CIA2 bank
//   STA $D016   (4 cy)  ; VIC CSEL/XSCROLL
//   STY $D011   (4 cy)  ; VIC YSCROLL/DEN  ← canonical: write at cy 12
//   LDX #$65    (2 cy)  ; load next bank value
//   STX $D018   (4 cy)  ; VIC bank        ← canonical: write at cy 18
//   ORA #$08    (2 cy)
//   STA $D016   (4 cy)  ; CSEL=1 for mid-line ← canonical: write at cy 24
//   INC $D017   (6 cy)  ; sprite Y-expand
//   LDY $3A17   (4 cy)  ; load Y from table
//   LDX $83FF,Y (5 cy)  ; load X from indexed table — base lo $FF + Y forces
//                       ;   page-cross → NMOS spec: 4 cy + 1 cy fix-hi cycle
//   NOP         (2 cy)
//   AND #$F7    (2 cy)
//   DEC $D017   (6 cy)
//   STX $DD02   (4 cy)
//   STA $D016   (4 cy)  ; CSEL=0 for hyperscreen ← canonical: write at cy 56
//   STY $D011   (4 cy)
//   LDX #$76    (2 cy)  ; preload next iter's first STX
//
// Sum: 4+4+4+2+4+2+4+6+4+5+2+2+6+4+4+4+2 = 63 cy
//
// The single 5-cy page-crossing LDX abs,Y is what brings the sum to a
// full PAL line. Without that page-cross the handler would underrun by
// 1 cycle per iteration, accumulating 14+ cycles of drift across the
// FPP band — exactly the failure mode this test is built to surface.

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

function makeMachine() {
  const m = new C64Machine();
  m.reset();
  m.mem.ram.fill(0xEA);
  m.cpu.pc = 0x1000;
  m.cpu.I = 0;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  m.mem.write(0x0001, 0x35);             // RAM at $A000-$FFFF
  // Disable display + sprites to avoid BA stalls.
  m.vic2.regs[0x11] = 0x00;
  m.vic2.regs[0x15] = 0x00;
  m.vic2.displayEnabled = false;
  return m;
}

function installHandler(m) {
  // Per the FppScroller trace at $9656..$9681. We use $1000+ to avoid
  // any I/O collision with $D000-$DFFF or KERNAL ROM.
  let p = 0x1000;
  // Storage for tables LDA reads from. Use ram pages.
  m.mem.ram[0x3A17] = 0x77;              // value LDY $3A17 returns
  // LDX $83FF,Y table — base lo $FF + Y=$77 → effective addr $8476.
  // The page-cross is essential: NMOS LDX abs,Y costs 4 cy without
  // crossing, 5 cy when (base_lo + Y) > $FF. Populate both the
  // off-page candidate read and the final effective addr so the read
  // resolves deterministically.
  for (let i = 0; i < 256; i++) m.mem.ram[0x8400 + i] = i;
  m.mem.ram[0x8476] = 0x76;
  // The handler:
  m.mem.ram[p++] = 0x8E; m.mem.ram[p++] = 0x02; m.mem.ram[p++] = 0xDD;  // STX $DD02
  m.mem.ram[p++] = 0x8D; m.mem.ram[p++] = 0x16; m.mem.ram[p++] = 0xD0;  // STA $D016
  m.mem.ram[p++] = 0x8C; m.mem.ram[p++] = 0x11; m.mem.ram[p++] = 0xD0;  // STY $D011
  m.mem.ram[p++] = 0xA2; m.mem.ram[p++] = 0x65;                          // LDX #$65
  m.mem.ram[p++] = 0x8E; m.mem.ram[p++] = 0x18; m.mem.ram[p++] = 0xD0;  // STX $D018
  m.mem.ram[p++] = 0x09; m.mem.ram[p++] = 0x08;                          // ORA #$08
  m.mem.ram[p++] = 0x8D; m.mem.ram[p++] = 0x16; m.mem.ram[p++] = 0xD0;  // STA $D016
  m.mem.ram[p++] = 0xEE; m.mem.ram[p++] = 0x17; m.mem.ram[p++] = 0xD0;  // INC $D017
  m.mem.ram[p++] = 0xAC; m.mem.ram[p++] = 0x17; m.mem.ram[p++] = 0x3A;  // LDY $3A17
  m.mem.ram[p++] = 0xBE; m.mem.ram[p++] = 0xFF; m.mem.ram[p++] = 0x83;  // LDX $83FF,Y (page-cross, 5 cy)
  m.mem.ram[p++] = 0xEA;                                                 // NOP
  m.mem.ram[p++] = 0x29; m.mem.ram[p++] = 0xF7;                          // AND #$F7
  m.mem.ram[p++] = 0xCE; m.mem.ram[p++] = 0x17; m.mem.ram[p++] = 0xD0;  // DEC $D017
  m.mem.ram[p++] = 0x8E; m.mem.ram[p++] = 0x02; m.mem.ram[p++] = 0xDD;  // STX $DD02
  m.mem.ram[p++] = 0x8D; m.mem.ram[p++] = 0x16; m.mem.ram[p++] = 0xD0;  // STA $D016
  m.mem.ram[p++] = 0x8C; m.mem.ram[p++] = 0x11; m.mem.ram[p++] = 0xD0;  // STY $D011
  m.mem.ram[p++] = 0xA2; m.mem.ram[p++] = 0x76;                          // LDX #$76 (next iter)
  return p;                                                              // end PC
}

// Run cycles until cpu.pc == endPc with instructionCyclesRemaining == 0,
// returning master-cycle count.
function countCyclesToEnd(m, endPc) {
  let cy = 0;
  const budget = 200;
  while (cy < budget) {
    cy++;
    C64Machine.prototype._runMasterCycle.call(m);
    if (m.cpu.pc === endPc && m.cpu.instructionCyclesRemaining === 0) return cy;
  }
  return -1;
}

// ── 1: SPEC INVARIANT — handler iteration = 63 cycles (PAL line).
//
// The handler runs once per raster line. For writes to land at the SAME
// cycle each line (= stable cycle positions per the cycle-position
// spec), the iteration MUST take exactly 63 master cycles.
//
// If iter takes 62 cy: writes drift -1 per line.
// If iter takes 64 cy: writes drift +1 per line.
// If iter takes 66 cy: writes drift +3 per line → +42 cy over 14 iters
//   (= the actual observed FppScroller drift).
//
// This test pins the SPEC invariant. Failure surfaces the cycle-count
// discrepancy in our impl.
{
  const m = makeMachine();
  const endPc = installHandler(m);
  m.cpu.pc = 0x1000;
  m.cpu.a = 0x00;
  m.cpu.x = 0x3F;
  m.cpu.y = 0x77;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  const cyc = countCyclesToEnd(m, endPc);
  expect(cyc === 63,
    `FPP handler body MUST take 63 cy per PAL line for stable cycle alignment; got ${cyc} cy (=${cyc - 63} cy drift per iter)`);
  ok(`FPP handler iteration = 63 cy (one PAL raster line)`);
}

// ── 2: Per-instruction breakdown verifies each instruction's contribution.
//
// Expected per-instruction cycle costs:
const expectedCycles = [
  { pc: 0x1000, name: 'STX $DD02', cy: 4 },
  { pc: 0x1003, name: 'STA $D016', cy: 4 },
  { pc: 0x1006, name: 'STY $D011', cy: 4 },
  { pc: 0x1009, name: 'LDX #$65',  cy: 2 },
  { pc: 0x100B, name: 'STX $D018', cy: 4 },
  { pc: 0x100E, name: 'ORA #$08',  cy: 2 },
  { pc: 0x1010, name: 'STA $D016', cy: 4 },
  { pc: 0x1013, name: 'INC $D017', cy: 6 },
  { pc: 0x1016, name: 'LDY $3A17', cy: 4 },
  { pc: 0x1019, name: 'LDX $83FF,Y', cy: 5 },  // page-cross: base lo $FF + Y > $FF → +1 cy
  { pc: 0x101C, name: 'NOP',       cy: 2 },
  { pc: 0x101D, name: 'AND #$F7',  cy: 2 },
  { pc: 0x101F, name: 'DEC $D017', cy: 6 },
  { pc: 0x1022, name: 'STX $DD02', cy: 4 },
  { pc: 0x1025, name: 'STA $D016', cy: 4 },
  { pc: 0x1028, name: 'STY $D011', cy: 4 },
  { pc: 0x102B, name: 'LDX #$76',  cy: 2 },
];
{
  for (const exp of expectedCycles) {
    const m = makeMachine();
    installHandler(m);
    m.cpu.pc = exp.pc;
    m.cpu.a = 0x00;
    m.cpu.x = 0x3F;
    m.cpu.y = 0x77;
    m.cpu.instructionCyclesRemaining = 0;
    m.cpu.microOpHead = 0;
    m.cpu.microOpLen = 0;
    const startPc = exp.pc;
    let cy = 0, budget = 20;
    // Run cycles until pc moves to the next instruction.
    while (cy < budget) {
      cy++;
      C64Machine.prototype._runMasterCycle.call(m);
      if (m.cpu.pc !== startPc && m.cpu.instructionCyclesRemaining === 0) break;
    }
    expect(cy === exp.cy,
      `${exp.name} at $${exp.pc.toString(16)}: ${exp.cy} cy; got ${cy}`);
  }
  ok('Per-instruction breakdown: each handler instruction matches expected cy count');
}

// ── 3: SPEC INVARIANT — sum of canonical NMOS cycle costs MUST be 63.
//
// Per Bauer + NMOS 6510 cycle tables, each instruction has a defined
// cycle count. The handler's 17 instructions, with LDX abs,Y costing
// 5 cy due to the deliberate page-crossing base lo of $FF, sum to
// exactly 63 cy = one PAL raster line. If our impl produces a
// different total, the discrepancy is in our cycle accounting for
// one or more of these instructions (test 2 surfaces which).
{
  const sum = expectedCycles.reduce((a, b) => a + b.cy, 0);
  expect(sum === 63,
    `canonical FPP handler iteration MUST sum to 63 cy (PAL line); reconstructed sequence sums to ${sum} cy (= ${sum - 63} cy off)`);
  ok(`Canonical handler iteration = 63 cy`);
}

console.log(`\n${testNo} FPP handler 63-cy sum spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
