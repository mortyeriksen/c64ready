// $D018 VM/CB sample-cycle characterization spec test.
//
// Bauer §3.6.3: CPU writes at PHI2 of cycle N visible to VIC from
// cycle N+1 phi1.
// Bauer §3.7.2: c-access for col K at cycle 15+K phi2 (samples $D018 VM).
// Bauer §3.7.4: g-access for col K at cycle 16+K phi1 (samples $D018 CB).
//
// For a CPU write at cycle N phi2:
//   VM boundary col(N) = N - 14  (15+K phi2 > N phi2)
//   CB boundary col(N) = N - 15  (16+K phi1 > N phi2, i.e., 16+K ≥ N+1)
//
// CB switches ONE COLUMN EARLIER than VM. This is the spec-driven
// difference FPP/FLD demos rely on.
//
// This test sweeps write cycles 17..28 and records the boundaries.
// The CB boundary should be exactly cy - 15, ONE less than VM (cy - 14).

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;

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

function colCanvasX(col) { return 32 + col * 8; }

// Setup screens + chars, write $D018 at phi2 of `writeCycle`, return
// observed VM boundary (first col with new VM code) and CB boundary
// (first col rendered with new CB glyph).
function runAt(writeCycle, newD018) {
  const vic = makeVic();
  // VM=$0400 codes = $11, VM=$2400 codes = $22.
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.ram[0x2400 + i] = 0x22;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  // CB=$0000 glyphs: $11 row 0 = $FF (yellow), $22 row 0 = $00 (blue).
  for (let b = 0; b < 8; b++) vic.ram[0x0000 + 0x11 * 8 + b] = 0xFF;
  for (let b = 0; b < 8; b++) vic.ram[0x0000 + 0x22 * 8 + b] = 0x00;
  // CB=$0800 glyphs: $11 row 0 = $0F (low nibble fg), $22 row 0 = $F0
  // (high nibble fg). These differ from CB=$0000 glyphs so we can
  // detect CB boundary even when VM didn't change.
  for (let b = 0; b < 8; b++) vic.ram[0x0800 + 0x11 * 8 + b] = 0x0F;
  for (let b = 0; b < 8; b++) vic.ram[0x0800 + 0x22 * 8 + b] = 0xF0;

  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;             // VM=$0400, CB=$0000
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x38 && vic.cycleInLine === writeCycle)) vic.clock(1);
  vic.write(0x18, newD018);
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  // VM boundary: first col with code != $11 (old VM value).
  let vmBoundary = 40;
  for (let col = 0; col < 40; col++) {
    if (vic.rowScreenCodes[col] !== 0x11) { vmBoundary = col; break; }
  }
  // CB boundary: first col whose first rendered pixel differs from
  // CB=$0000 expected glyph. With code being either $11 or $22 depending
  // on VM, the expected pixel sets are:
  //   CB=$0000: glyph $11 row 0 = $FF → 8 yellow; glyph $22 row 0 = $00 → 8 blue.
  //   CB=$0800: glyph $11 row 0 = $0F → 4 blue + 4 yellow; glyph $22 row 0 = $F0 → 4 yellow + 4 blue.
  // So col K with NEW CB has different pixel pattern than col K with OLD CB.
  const canvasY = 0x38 - 15;
  const ro = canvasY * CANVAS_W;
  let cbBoundary = 40;
  for (let col = 0; col < 40; col++) {
    const x = colCanvasX(col);
    const px0 = vic.fb32[ro + x];
    const px4 = vic.fb32[ro + x + 4];
    // Same as CB=$0000 expectation? (px0 === px4)
    if (px0 !== px4) { cbBoundary = col; break; }
  }
  return { vmBoundary, cbBoundary, vic };
}

// ── 1: Write at cy 20 — VM boundary at col 6, CB boundary at col 5.
//   VM: col >= 20-14 = 6 → new VM (smallest col where 15+col > 20).
//   CB: col >= 20-15 = 5 → new CB.
{
  const { vmBoundary, cbBoundary } = runAt(20, 0x90);  // VM=$2400, CB=$0000
  expect(vmBoundary === 6,
    `cy 20 write: VM boundary = N-14 = 6 per c-access sampling; got ${vmBoundary}`);
  // The CB boundary stays at 40 because CB didn't change (0x90 keeps CB=$0000).
  expect(cbBoundary === 40,
    `cy 20 VM-only write: no CB change → no glyph-pattern shift; got ${cbBoundary}`);
  ok('Bauer §3.7.4: $D018 VM-only write at cy 20 → VM boundary at col 6, no CB shift');
}

// ── 2: Write at cy 20 — CB-only change, VM unchanged.
//   VM: stays = no boundary (vmBoundary = 40).
//   CB: col >= 20-15 = 5 → new CB per Bauer §3.7.4 (g-access cy 16+K phi1 ≥ N+1).
{
  const { vmBoundary, cbBoundary } = runAt(20, 0x12);  // VM=$0400, CB=$0800
  expect(vmBoundary === 40,
    `cy 20 CB-only write: VM unchanged → no code split; got ${vmBoundary}`);
  expect(cbBoundary === 5,
    `cy 20 CB-only write: strict Bauer §3.7.4 CB boundary = N-15 = 5 (g-access cy 16+K ≥ 21); got ${cbBoundary}`);
  ok('Bauer §3.7.4: $D018 CB-only write at cy 20 → CB boundary at col 5 (g-access cy 16+col > 20)');
}

// ── 3: Sweep cy 17..28, characterize CB boundary (CB-only writes).
//   Expected per Bauer §3.7.4: CB boundary = N - 15 (g-access at cycle 16+col phi1).
{
  const obs = [];
  for (let cy = 17; cy <= 28; cy++) {
    const { cbBoundary } = runAt(cy, 0x12);
    obs.push({ cy, cb: cbBoundary });
  }
  console.log(`     CB boundary table: ${obs.map(o => `cy${o.cy}→col${o.cb}`).join(', ')}`);
  for (const { cy, cb } of obs) {
    expect(cb === cy - 15,
      `cy ${cy} CB-only: strict Bauer §3.7.4 CB boundary = ${cy - 15}; got col ${cb}`);
  }
  ok('Bauer §3.7.4: CB boundary = (write_cycle - 15) across cy 17..28 (one earlier than VM)');
}

// ── 4: VM boundary sweep cy 17..28 (VM-only write 0x10 → 0x90).
//   Expected: VM boundary = cy - 14.
{
  const obs = [];
  for (let cy = 17; cy <= 28; cy++) {
    const { vmBoundary } = runAt(cy, 0x90);
    obs.push({ cy, vm: vmBoundary });
  }
  console.log(`     VM boundary table: ${obs.map(o => `cy${o.cy}→col${o.vm}`).join(', ')}`);
  for (const { cy, vm } of obs) {
    expect(vm === cy - 14,
      `cy ${cy} VM-only: c-access boundary = ${cy - 14}; got col ${vm}`);
  }
  ok('Bauer §3.7.2: VM boundary = (write_cycle - 14) across cy 17..28');
}

console.log(`\n${testNo} $D018 sample-cycle characterization spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
