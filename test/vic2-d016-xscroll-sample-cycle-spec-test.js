// $D016 XSCROLL sample-cycle characterization spec test.
//
// Bauer §3.7.2 + §3.7.3: $D016 bits 0..2 (XSCROLL) delay the graphics
// shifter reload after g-accesses. A mid-line $D016 write therefore reaches
// the visible pixels on the graphics output-stage timeline, not the raw
// register-write cycle.
//
// Compared to $D018 which has TWO independent sample points (c-access
// at cy 15+col, g-access at cy 16+col), $D016 XSCROLL is a single
// renderer parameter. Per Bauer the XSCROLL is sampled at each pixel
// of the rendering pipeline, so a write at PHI2 of cycle N produces a
// boundary at col = N - 11 (smallest col whose segment cycle 12+col
// > N — inner display segments start at cy 12).
//
// Inner-display columns start at cy 15 (col 0 at cy 15), but graphics data is
// displayed after the VIC's documented pipeline delay. The renderer's fixup
// therefore samples XSCROLL at the same delayed c+2 output-stage point used
// for mid-line mode changes.
//
// This file sweeps $D016 XSCROLL writes and characterizes the actual
// pixel-shift boundary. If our impl samples the raw register cycle instead of
// the delayed shifter-reload point, the Fairlight 1337 first text column loses
// its foreground priority and behind-priority sprites show through.
//
// Audit gap: $D016 XSCROLL mid-line sample cycle — not previously
// covered. d016-res-bit-spec-test.js covers the RES bit (bit 5) only.

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

// Setup: VM=$0400 with col 5 = $11 (all-fg glyph), all other cols =
// $00 (all-bg glyph). Write $D016 at PHI2 of `writeCycle` setting
// new XSCROLL. Observe first-yellow canvas-X position.
function runWithXscrollWriteAt(writeCycle, newXscroll) {
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x00;
  for (let row = 0; row < 25; row++) vic.ram[0x0400 + row * 40 + 5] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  for (let b = 0; b < 8; b++) vic.ram[0x11 * 8 + b] = 0xFF;
  for (let b = 0; b < 8; b++) vic.ram[0x00 * 8 + b] = 0x00;
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;       // CSEL=1, XSCROLL=0
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x38 && vic.cycleInLine === writeCycle)) vic.clock(1);
  vic.write(0x16, 0x08 | (newXscroll & 7));
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  // Find first yellow pixel canvas-X.
  const ro = (0x38 - 15) * CANVAS_W;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.fb32[ro + x] === PAL(0x07)) return x;
  }
  return -1;
}

// ── 1: Baseline — no write, XSCROLL=0 throughout → col 5 at canvas X=72.
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x00;
  for (let row = 0; row < 25; row++) vic.ram[0x0400 + row * 40 + 5] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  for (let b = 0; b < 8; b++) vic.ram[0x11 * 8 + b] = 0xFF;
  for (let b = 0; b < 8; b++) vic.ram[0x00 * 8 + b] = 0x00;
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);
  const ro = (0x38 - 15) * CANVAS_W;
  let firstYellow = -1;
  for (let x = 0; x < CANVAS_W; x++) if (vic.fb32[ro + x] === PAL(0x07)) { firstYellow = x; break; }
  expect(firstYellow === 72,
    `XSCROLL=0 baseline: first yellow at canvas X=72 (col 5); got ${firstYellow}`);
  ok('XSCROLL=0 baseline: col 5 fg glyph at canvas X=72');
}

// ── 2: Pre-line XSCROLL=3 — first yellow at X=72+3=75.
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x00;
  for (let row = 0; row < 25; row++) vic.ram[0x0400 + row * 40 + 5] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  for (let b = 0; b < 8; b++) vic.ram[0x11 * 8 + b] = 0xFF;
  for (let b = 0; b < 8; b++) vic.ram[0x00 * 8 + b] = 0x00;
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x0B;       // CSEL=1, XSCROLL=3
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);
  const ro = (0x38 - 15) * CANVAS_W;
  let firstYellow = -1;
  for (let x = 0; x < CANVAS_W; x++) if (vic.fb32[ro + x] === PAL(0x07)) { firstYellow = x; break; }
  expect(firstYellow === 75,
    `XSCROLL=3 pre-line: first yellow at canvas X=75 (col 5 + 3px shift); got ${firstYellow}`);
  ok('XSCROLL=3 pre-line: col 5 shifts right by 3 pixels');
}

// ── 3: Mid-line $D016 XSCROLL change — characterize the cycle at which
// new XSCROLL begins to affect pixels.
//
// Write at PHI2 of cycle N changes XSCROLL from 0 to 3. The boundary is
// the first column whose pixels reflect the new XSCROLL after the graphics
// shifter-reload delay.
//
// Empirically: with our col-5 marker, the marker's canvas position
// depends on which cycle's XSCROLL the renderer uses for col 5. We
// sweep write cycles and observe whether col 5 shifts.
//
// For cycles N ≤ 21, the write lands before col 5's delayed output-stage
// XSCROLL sample, so col 5 uses new XSCROLL=3 → shifts to X=75.
// For cycles N ≥ 22, the delayed sample has already captured old
// XSCROLL=0 → col 5 stays at X=72.
{
  const cycles = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  const obs = cycles.map(cy => ({ cy, x: runWithXscrollWriteAt(cy, 3) }));
  console.log(`     XSCROLL sample table: ${obs.map(o => `cy${o.cy}→X${o.x}`).join(', ')}`);
  // Boundary cycle: first cy where col 5 STAYS at X=72 (= write was too late).
  let boundary = -1;
  for (const o of obs) {
    if (o.x === 72) { boundary = o.cy; break; }
  }
  expect(boundary === 22,
    `XSCROLL mid-line boundary: expected cy 22 (col 5 unaffected); got cy ${boundary}`);
  ok(`Bauer §3.7.3: $D016 XSCROLL shifter-reload sample reaches col 5 through cy 21`);
}

// ── 4: Sweep verifies pixel shift = exactly 3 for write before boundary.
{
  const earlyWrites = [14, 15, 16, 17, 18, 19, 20, 21];
  for (const cy of earlyWrites) {
    const x = runWithXscrollWriteAt(cy, 3);
    expect(x === 75,
      `early write at cy ${cy}: col 5 should shift +3 to X=75; got ${x}`);
  }
  ok('Bauer §3.7.3: $D016 XSCROLL write before col 5\'s delayed shifter sample shifts col 5 by exactly 3 pixels');
}

// ── 5: Writes at/after the delayed sample do not move the current column.
{
  for (const cy of [22, 23]) {
    const x = runWithXscrollWriteAt(cy, 3);
    expect(x === 72,
      `late write at cy ${cy}: col 5 should stay at X=72; got ${x}`);
  }
  ok('Bauer §3.7.3: $D016 XSCROLL writes at/after the delayed sample wait for the next column');
}

console.log(`\n${testNo} $D016 XSCROLL sample-cycle spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
