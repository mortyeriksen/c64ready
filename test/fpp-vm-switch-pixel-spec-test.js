// FPP/FLD per-line $D018 VM-bit change → PIXEL DATA spec test.
//
// Bauer §3.7.2 + §3.6.3: each bad-line c-access reads ONE screen code
// from VM+col_index. A mid-line $D018 write changes the VM for SUBSEQUENT
// c-access cycles. The fetched codes then feed g-access which uses the
// CHARACTER BASE (CB) from $D018 to look up glyph bytes.
//
// FppScroller and other FPP-style demos rely on the END-TO-END pixel
// chain working: write $D018 → new codes fetched → glyphs render with
// the NEW screen-RAM data. A regression that breaks the pixel chain
// (e.g., g-access samples a stale lineCycleRegs snapshot) would NOT be
// caught by midline-d018-vm-change-spec-test.js, which only inspects
// rowScreenCodes. This file closes that gap.
//
// Coverage gap audit (2026-05-18): rated "FPP per-line VM bank switching
// produces correct pixel data" — ✗ before this file.

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

// Render-time canvas X for column C (0-39): each cycle is 8 pixels wide,
// inner display starts at cycle 15 → canvas X = (15-12)*8 + 8 = 32.
function colCanvasX(col) { return 32 + col * 8; }

// ── 1: Pre-write columns render OLD-VM glyph; post-write columns render
// NEW-VM glyph. Bauer §3.7.2 c-access + §3.7.3.1 standard text mode.
//
// Setup:
//   VM₀=$0400 → screen codes = $11 (uniform).
//   VM₁=$2400 → screen codes = $22 (uniform). (Avoid $1000-$1FFF char-ROM
//                                              shadow.)
//   CB=$0000, glyph $11 row 0 = $FF (all-fg), glyph $22 row 0 = $00 (all-bg).
//   fg = color RAM (uniform = $07 yellow), bg = $D021 = $06 blue.
//
// Mid c-access write at cycle 25 → cols 11+ use VM₁.
// Expected: cols 0-10 render YELLOW pixels (glyph $11 = all-fg).
//           cols 11-39 render BLUE pixels (glyph $22 = all-bg).
{
  const vic = makeVic();
  // Screen RAM
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.ram[0x2400 + i] = 0x22;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  // Char data at CB=$0000.
  // Each glyph = 8 bytes. glyph $11 at $88, glyph $22 at $110.
  for (let b = 0; b < 8; b++) vic.ram[0x11 * 8 + b] = 0xFF;
  for (let b = 0; b < 8; b++) vic.ram[0x22 * 8 + b] = 0x00;

  vic.regs[0x11] = 0x18;     // DEN=1, RSEL=1, YSCROLL=0, mode=text
  vic.regs[0x16] = 0x08;     // CSEL=1
  vic.regs[0x18] = 0x10;     // VM=$0400, CB=$0000
  vic.regs[0x20] = 0x00;
  vic.regs[0x21] = 0x06;     // bg = blue
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x38 && vic.cycleInLine === 25)) vic.clock(1);
  vic.write(0x18, 0x90);     // VM=$2400 (CB unchanged)
  // Run to end of line; renderer pushes pixels into fb32 incrementally.
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  const canvasY = 0x38 - 15;
  const ro = canvasY * CANVAS_W;

  // Pre-write columns (0-10) → glyph $11 = all-fg yellow.
  for (let col = 0; col <= 10; col++) {
    const x = colCanvasX(col);
    expect(vic.fb32[ro + x] === PAL(0x07),
      `col ${col} pre-VM-switch: expected yellow (glyph $11 from VM=$0400), got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  // Post-write columns (11-39) → glyph $22 = all-bg blue.
  for (let col = 11; col < 40; col++) {
    const x = colCanvasX(col);
    expect(vic.fb32[ro + x] === PAL(0x06),
      `col ${col} post-VM-switch: expected blue (glyph $22 from VM=$2400), got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('Bauer §3.7.2 + §3.7.3.1: mid-line $D018 VM change splits PIXEL output at boundary');
}

// ── 2: VM bank stays put (no write) → all columns use VM₀.
// Sanity baseline so a future regression that, e.g., always reads from
// "next VM" cannot pass test 1 by accident.
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.ram[0x2400 + i] = 0x22;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  for (let b = 0; b < 8; b++) vic.ram[0x11 * 8 + b] = 0xFF;
  for (let b = 0; b < 8; b++) vic.ram[0x22 * 8 + b] = 0x00;
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
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  const canvasY = 0x38 - 15;
  const ro = canvasY * CANVAS_W;
  let yellowCols = 0, blueCols = 0;
  for (let col = 0; col < 40; col++) {
    const px = vic.fb32[ro + colCanvasX(col)];
    if (px === PAL(0x07)) yellowCols++;
    else if (px === PAL(0x06)) blueCols++;
  }
  expect(yellowCols === 40, `no-write baseline: expected 40 yellow cols (VM₀), got ${yellowCols}`);
  expect(blueCols === 0, `no-write baseline: expected 0 blue cols, got ${blueCols}`);
  ok('Bauer §3.7.2: no mid-line $D018 write → all 40 cols render VM₀ glyph data');
}

// ── 3: VM + CB simultaneous mid-line change (FPP-style).
//
// Per Bauer §3.7.4 the c-access (VM) for col K fires at cy 15+K phi2 and
// the g-access (CB) at cy 16+K phi1. A CPU write at cy N phi2 is visible
// to the VIC from cy N+1 phi1 (Bauer §3.6.3). So a write at cy 30 phi2
// gives DIFFERENT col boundaries for VM vs CB:
//   - VM boundary: first col with c-access cy ≥ 31 → col 16+.
//   - CB boundary: first col with g-access cy ≥ 31 → col 15+ (one earlier).
//
// This produces THREE display regions instead of two:
//   - cols 0..14 : OLD VM ($11) + OLD CB ($0000) → glyph $11 at $0000.
//   - col   15   : OLD VM ($11) + NEW CB ($0800) → glyph $11 at $0800.
//   - cols 16..39: NEW VM ($22) + NEW CB ($0800) → glyph $22 at $0800.
//
// Data layout (chosen so all three regions render distinct patterns):
//   CB=$0000, glyph $11 row 0 = $FF (all-fg yellow).
//   CB=$0800, glyph $11 row 0 = $00 (all-bg blue).
//   CB=$0800, glyph $22 row 0 = $0F (first 4 blue, last 4 yellow).
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.ram[0x2400 + i] = 0x22;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;
  for (let b = 0; b < 8; b++) vic.ram[0x0000 + 0x11 * 8 + b] = 0xFF;
  for (let b = 0; b < 8; b++) vic.ram[0x0800 + 0x11 * 8 + b] = 0x00;
  for (let b = 0; b < 8; b++) vic.ram[0x0800 + 0x22 * 8 + b] = 0x0F;
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
  while (!(vic.raster === 0x38 && vic.cycleInLine === 30)) vic.clock(1);
  vic.write(0x18, 0x92);     // VM=$2400, CB=$0800
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);

  const canvasY = 0x38 - 15;
  const ro = canvasY * CANVAS_W;
  // Region 1: cols 0..14 → OLD VM + OLD CB → all yellow.
  for (let col = 0; col <= 14; col++) {
    const x = colCanvasX(col);
    for (let bit = 0; bit < 8; bit++) {
      expect(vic.fb32[ro + x + bit] === PAL(0x07),
        `pre col ${col} bit ${bit}: expected yellow (OLD VM $11 + OLD CB $0000), got 0x${vic.fb32[ro + x + bit].toString(16)}`);
    }
  }
  // Region 2: col 15 → OLD VM ($11) + NEW CB ($0800), glyph $11 at $0800 = $00 → all blue.
  {
    const x = colCanvasX(15);
    for (let bit = 0; bit < 8; bit++) {
      expect(vic.fb32[ro + x + bit] === PAL(0x06),
        `hybrid col 15 bit ${bit}: expected blue (OLD VM $11 + NEW CB $0800 glyph $11 row 0=$00), got 0x${vic.fb32[ro + x + bit].toString(16)}`);
    }
  }
  // Region 3: cols 16..39 → NEW VM + NEW CB → $0F (first 4 blue, last 4 yellow).
  for (let col = 16; col < 40; col++) {
    const x = colCanvasX(col);
    for (let bit = 0; bit < 4; bit++) {
      expect(vic.fb32[ro + x + bit] === PAL(0x06),
        `post col ${col} bit ${bit}: expected blue (NEW VM $22 + NEW CB $0800 glyph $22 bit=0), got 0x${vic.fb32[ro + x + bit].toString(16)}`);
    }
    for (let bit = 4; bit < 8; bit++) {
      expect(vic.fb32[ro + x + bit] === PAL(0x07),
        `post col ${col} bit ${bit}: expected yellow (NEW VM $22 + NEW CB $0800 glyph $22 bit=1), got 0x${vic.fb32[ro + x + bit].toString(16)}`);
    }
  }
  ok('Bauer §3.7.4 + §3.6.3: VM+CB simultaneous write → col 15 = hybrid OLD-VM/NEW-CB (g-access leads c-access by 1 col)');
}

console.log(`\n${testNo} FPP VM-switch pixel spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
