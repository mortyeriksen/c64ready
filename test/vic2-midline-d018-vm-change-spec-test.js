// Mid-c-access $D018 VM-bit change spec test.
//
// Bauer §3.7.4 + §3.6.3: $D018 bits 7-4 select the video matrix base
// (VM) in 1KB units within the current 16KB VIC bank. Each bad-line
// c-access cycle (cy 15-54 in the 40-col fetch) reads ONE screen code
// at VM + col_index. A CPU write to $D018 mid-c-access changes the VM
// for SUBSEQUENT c-access cycles within the same line.
//
// FPP/FLD scroller demos rely on this to display a DIFFERENT row of
// screen RAM on each scanline by writing $D018 mid-c-access. If a
// future change makes the VM-bit change take effect at the wrong
// cycle (or not at all), FPP central-display rendering breaks
// regardless of whether the demo's cycle-counted handler hit the
// write at the right cycle.
//
// Existing coverage:
//   gaccess-shifter-spec-test.js — same test but for CB-bit change.
//   This file covers the parallel case for VM-bit changes.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  return vic;
}

// ── 1: VM-bit change mid-c-access splits the rowScreenCodes between
// old and new VM. Cycles ≤ N use old VM; cycles ≥ N+1 use new VM.
//
// Spec: Bauer §3.7.2 — c-access reads ONE screen code at video matrix
// base + col_index per bad-line cycle. Bauer §3.6.3 — CPU writes at
// phi2 of cycle N are visible to the VIC starting cycle N+1.
{
  const vic = makeVic();
  // Two screen-RAM regions (chosen to avoid char-ROM shadow at $1000-$1FFF):
  //   VM=$0400 → fill with code $11 ("first half" identifier)
  //   VM=$2400 → fill with code $22 ("second half" identifier)
  // (VM bit = $0400 unit; $D018=0x10 -> VM $0400, $D018=0x90 -> VM $2400.)
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.ram[0x2400 + i] = 0x22;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  vic.regs[0x11] = 0x18;        // DEN=1, RSEL=1, YSCROLL=0
  vic.regs[0x16] = 0x08;        // CSEL=1
  vic.regs[0x18] = 0x10;        // VM=$0400, CB=$0000
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  // Drive past L$30 to latch displayEnabled, then to bad-line L$38.
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  // Drive to c25 of L$38 (mid c-access window).
  while (!(vic.raster === 0x38 && vic.cycleInLine === 25)) vic.clock(1);
  // CPU writes $D018 at PHI2 of cycle 25 → VIC sees it from cycle 26.
  vic.write(0x18, 0x90);        // VM=$2400, CB=$0000 (unchanged)
  // Drive to end of line.
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  // c-access fires cycles 15-54 inclusive (40 cols, col N at cy 15+N).
  // Cycle 25 = col 10. Cycle 26 = col 11.
  // Cycles ≤25 (cols 0-10) read from VM=$0400 → code $11.
  // Cycles ≥26 (cols 11-39) read from VM=$2400 → code $22.
  const codes = vic.rowScreenCodes;
  for (let col = 0; col <= 10; col++) {
    expect(codes[col] === 0x11,
      `col ${col} (cy ${15+col}, pre-write): expected old-VM code $11, got $${codes[col].toString(16)}`);
  }
  for (let col = 11; col < 40; col++) {
    expect(codes[col] === 0x22,
      `col ${col} (cy ${15+col}, post-write): expected new-VM code $22, got $${codes[col].toString(16)}`);
  }
  ok('Bauer §3.7.2 + §3.6.3: mid-line $D018 VM change splits c-access at cycle boundary (cycle N+1 onward = new VM)');
}

// ── 2: Simultaneous VM + CB change in one $D018 write.
// FPP scroller demos write $D018 mid-c-access to change BOTH VM and
// CB at once. c-access from the new VM, g-access from the new CB.
{
  const vic = makeVic();
  // VM=$0400 codes = $01, VM=$2400 codes = $05 (outside char-ROM shadow).
  // CB=$0000 (chars at $0000-$07FF) and CB=$0800 (chars at $0800-$0FFF) are
  // both outside the char-ROM shadow region.
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x01;
  for (let i = 0; i < 0x0400; i++) vic.ram[0x2400 + i] = 0x05;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  // CB=$0000 char data
  vic.ram[0x0000 + 0x01 * 8] = 0xAA;
  vic.ram[0x0000 + 0x05 * 8] = 0xC0;
  // CB=$0800 char data
  vic.ram[0x0800 + 0x01 * 8] = 0x55;
  vic.ram[0x0800 + 0x05 * 8] = 0x0F;
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;        // VM=$0400, CB=$0000
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x38 && vic.cycleInLine === 30)) vic.clock(1);
  // Change VM=$0400→$2400 AND CB=$0000→$0800 in one write.
  vic.write(0x18, 0x92);        // VM=$2400, CB=$0800
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  // Codes (c-access): cols ≤15 (cy ≤30) = $01 (old VM). Cols ≥16 = $05 (new VM).
  const codes = vic.rowScreenCodes;
  expect(codes[15] === 0x01,
    `col 15 (cy 30, pre-write boundary): expected old-VM code $01, got $${codes[15].toString(16)}`);
  expect(codes[16] === 0x05,
    `col 16 (cy 31, post-write boundary): expected new-VM code $05, got $${codes[16].toString(16)}`);
  ok('Bauer §3.7.4: simultaneous $D018 VM+CB change applies to subsequent c-access (FPP technique)');
}

// ── 3: $D018 write AFTER c-access window does NOT affect this line's
// c-access (= writes at cy 55+ only affect NEXT line's bad-line fetch).
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.ram[0x1400 + i] = 0x22;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  // Drive past the entire c-access window (cy 15-54) to cy 60.
  while (!(vic.raster === 0x38 && vic.cycleInLine === 60)) vic.clock(1);
  vic.write(0x18, 0x50);        // VM=$1400 (too late)
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  // All 40 cols should still be $11 (old VM) — write was past c-access.
  const codes = vic.rowScreenCodes;
  let nonOld = 0;
  for (let col = 0; col < 40; col++) if (codes[col] !== 0x11) nonOld++;
  expect(nonOld === 0,
    `post-c-access $D018 write must not affect this line's c-access; ${nonOld} cols show new VM`);
  ok('Bauer §3.7.2: $D018 write after c-access window (cy ≥55) leaves THIS line\'s codes untouched');
}

console.log(`\n${testNo} mid-line $D018 VM-change spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
