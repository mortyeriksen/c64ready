// Mid-line $D018 CB-only change — g-access PIXEL spec test.
//
// Bauer §3.6.3: CPU writes at PHI2 of cycle N are visible to the VIC
// starting cycle N+1 phi1.
// Bauer §3.7.2 + §3.7.4: c-access for col K at cycle 15+K phi2 fetches
// the screen code. g-access for col K at cycle 16+K phi1 fetches the
// character data using $D018 CB bits.
//
// So for a CPU write to $D018 at PHI2 of cycle N:
//   VM boundary col K: 15+K phi2 > N phi2 → K ≥ N - 14
//   CB boundary col K: 16+K phi1 > N phi2 → K ≥ N - 15  (one col EARLIER)
//
// The two boundaries differ by 1 column. FPP/FLD demos rely on this
// 1-col offset for the g-access "lead" they need.
//
// Audit gap C3: "Mid-c-access $D018 CB-only change → g-access glyph
// base shifts; codes unchanged" — tests strict Bauer-spec CB boundary
// at col N-15 (one earlier than VM). Failure surfaces if our impl
// samples CB at the c-access cycle instead of the g-access cycle.

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

// ── 1: CB-only mid-line change preserves all 40 screen codes (VM unchanged)
//
// Write at cy 25 changes $D018 CB only. Codes (all from same VM) must
// remain unchanged across the boundary.
{
  const vic = makeVic();
  // VM=$0400, all codes = $11.
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;     // VM=$0400, CB=$0000
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x38 && vic.cycleInLine === 25)) vic.clock(1);
  vic.write(0x18, 0x14);     // VM=$0400 (unchanged), CB=$0800 (was $0000)
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  const codes = vic.rowScreenCodes;
  let mismatched = 0;
  for (let col = 0; col < 40; col++) if (codes[col] !== 0x11) mismatched++;
  expect(mismatched === 0,
    `CB-only change: all 40 codes must remain $11 (VM unchanged); ${mismatched} mismatched`);
  ok('Bauer §3.7.4: $D018 CB-only change leaves screen codes (c-access) untouched');
}

// ── 2: CB-only mid-line change splits glyph rendering at g-access boundary.
//
// Pre-write CB=$0000: glyph $11 row 0 = $FF (all-fg yellow).
// Post-write CB=$0800: glyph $11 row 0 = $00 (all-bg blue).
//
// Per Bauer §3.7.4: g-access for col K at cycle 16+K phi1.
// Write at cy 25 phi2 visible from cy 26 phi1.
// Col K g-access sees new CB iff 16+K ≥ 26 → K ≥ 10. So:
//   cols 0..9   → render from CB=$0000 (all-fg yellow).
//   cols 10..39 → render from CB=$0800 (all-bg blue).
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  // CB=$0000: glyph $11 row 0 = $FF
  for (let b = 0; b < 8; b++) vic.ram[0x0000 + 0x11 * 8 + b] = 0xFF;
  // CB=$0800: glyph $11 row 0 = $00
  for (let b = 0; b < 8; b++) vic.ram[0x0800 + 0x11 * 8 + b] = 0x00;
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;     // VM=$0400, CB=$0000
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x38 && vic.cycleInLine === 25)) vic.clock(1);
  vic.write(0x18, 0x14);     // VM=$0400, CB=$0800
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  const canvasY = 0x38 - 15;
  const ro = canvasY * CANVAS_W;
  // Cols 0..9 = old CB ($FF) → 8 yellow pixels each (g-access at cy 16+col ≤ 25).
  for (let col = 0; col <= 9; col++) {
    const x = colCanvasX(col);
    expect(vic.fb32[ro + x] === PAL(0x07),
      `col ${col} (g-access cy ${16+col} ≤ 25): expected old-CB yellow, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  // Cols 10..39 = new CB ($00) → 8 blue pixels each (g-access cy 16+col > 25).
  for (let col = 10; col <= 39; col++) {
    const x = colCanvasX(col);
    expect(vic.fb32[ro + x] === PAL(0x06),
      `col ${col} (g-access cy ${16+col} > 25): expected new-CB blue, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('Bauer §3.7.4: $D018 CB write at cy 25 phi2 → g-access cy 26+ (col 10+) use new CB');
}

// ── 3: $D018 CB write at PHI2 of cy 54 — affects col 39's g-access ONLY.
//
// g-access for col 39 is at cy 55 phi1 (= one cycle AFTER the c-access
// at cy 54). Write at cy 54 phi2 visible from cy 55 phi1. So col 39's
// g-access sees the new CB while all other cols use old CB.
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  // CB=$0000 glyph $11 row 0 = $FF (yellow), CB=$0800 glyph $11 row 0 = $00 (blue).
  for (let b = 0; b < 8; b++) vic.ram[0x0000 + 0x11 * 8 + b] = 0xFF;
  for (let b = 0; b < 8; b++) vic.ram[0x0800 + 0x11 * 8 + b] = 0x00;
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;     // CB=$0000
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x38 && vic.cycleInLine === 54)) vic.clock(1);
  vic.write(0x18, 0x14);     // CB=$0800
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  const canvasY = 0x38 - 15;
  const ro = canvasY * CANVAS_W;
  // Cols 0..38 used old CB → yellow (g-access at cy 16..54 ≤ 54).
  for (const col of [0, 10, 20, 38]) {
    const x = colCanvasX(col);
    expect(vic.fb32[ro + x] === PAL(0x07),
      `col ${col} (g-access cy ${16+col} ≤ 54): expected old-CB yellow, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  // Col 39 g-access at cy 55 > 54 → uses new CB → blue.
  const xCol39 = colCanvasX(39);
  expect(vic.fb32[ro + xCol39] === PAL(0x06),
    `col 39 (g-access cy 55 > 54): expected new-CB blue, got 0x${vic.fb32[ro + xCol39].toString(16)}`);
  ok('Bauer §3.7.4: $D018 CB write at cy 54 phi2 → only col 39 g-access uses new CB');
}

// ── 4: $D018 CB write at PHI2 of cy 55 — too late, no col on THIS line
// affected. (Next line's c-access uses new VM/CB, but we don't test the
// next line here — that's covered by no-write baseline in test 1.)
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  for (let b = 0; b < 8; b++) vic.ram[0x0000 + 0x11 * 8 + b] = 0xFF;
  for (let b = 0; b < 8; b++) vic.ram[0x0800 + 0x11 * 8 + b] = 0x00;
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
  while (!(vic.raster === 0x38 && vic.cycleInLine === 55)) vic.clock(1);
  vic.write(0x18, 0x14);     // CB=$0800 — too late for this line's g-access
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  const canvasY = 0x38 - 15;
  const ro = canvasY * CANVAS_W;
  let blueCols = 0;
  for (let col = 0; col < 40; col++) {
    if (vic.fb32[ro + colCanvasX(col)] === PAL(0x06)) blueCols++;
  }
  expect(blueCols === 0,
    `post-g-access $D018 write must not affect THIS line's glyphs; ${blueCols} cols turned blue`);
  ok('Bauer §3.7.4: $D018 CB write at cy ≥ 55 leaves this line\'s g-access untouched');
}

console.log(`\n${testNo} mid-line $D018 CB spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
