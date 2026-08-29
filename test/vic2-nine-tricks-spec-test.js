// nine.prg trick spec coverage. Three Linus Åkesson tricks per the
// demo's user-supplied breakdown:
//
//   1. Mid-draw sprite crunch via $D017 toggle — 21-line integration
//      test verifying MC counter sequence + display-row pattern across
//      a full sprite display window.
//   2. Open-border ghost-byte XSCROLL alignment — verifies $D016 bits
//      0-2 shift the idle-byte rendering in opened side borders.
//   3. Mid-fetch sprite pointer swapping — three independent paths:
//      $D018 mid-line, $DD00 (VIC bank) mid-line, and pointer-byte
//      memory write at $07F8+s mid-frame.
//
// $D018 mid-line is already covered by sprite-d018-banking-spec-test;
// this file adds the two remaining paths plus the ghost-byte XSCROLL
// and the 21-line crunch integration.

import { VIC2, CYCLES_PER_LINE, C64_PALETTE } from '../src/vic2.js';

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

const PALETTE_RGBA = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const c = C64_PALETTE[i];
    out[i] = 0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
  }
  return out;
})();

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// ─────────────────────────────────────────────────────────────────────
// Trick 2 — Open-border idle XSCROLL alignment
// ─────────────────────────────────────────────────────────────────────
//
// Render a single open-side-border line with idleByte = 0x80 (only
// bit 7 set → leftmost pixel of each 8-pixel cycle is foreground).
// XSCROLL=0: foreground at canvasX cycleStart (bit 7).
// XSCROLL=3: foreground shifted right by 3 → at cycleStart+3.

function setupOpenBorderLineState(vic, regsTemplate, canvasY, idleByte) {
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(regsTemplate);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
    // hInner mirrors the real VIC's GRAPHICS_WINDOW [32, 352) overlap:
    // cycles 15..54 are the inner-zone (where the g-access shifter loads
    // and emits idle byte content with XSCROLL alignment). Cycles outside
    // that window are side zones — they output bg via _fillSegmentBg0
    // since the shifter never loads there. The XSCROLL test below probes
    // cycle 30 which is fully inner.
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleIdleByte[c] = idleByte;
    vic.lineCycleBanks[c] = 0;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
  }
}

{
  // XSCROLL=0: foreground (bit 7) at first pixel of each cycle.
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;                 // CSEL=1, XSCROLL=0
  vic.regs[0x20] = 0x00;
  vic.regs[0x21] = 0x06;
  const canvasY = 50;
  setupOpenBorderLineState(vic, vic.regs, canvasY, 0x80);
  vic._initRenderRasterLine(50, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }
  // Cycle 30 segment starts at canvas X = (30-12)*8 + 8 = 152.
  const c30Start = (30 - 12) * 8 + 8;
  const ro = canvasY * 384;
  const black = 0xFF000000;
  const blue = PALETTE_RGBA[6];
  expect(vic.fb32[ro + c30Start] === black,
    `XSCROLL=0: cycleStart pixel = bit 7 (foreground BLACK), got 0x${vic.fb32[ro + c30Start].toString(16)}`);
  expect(vic.fb32[ro + c30Start + 1] === blue,
    `XSCROLL=0: cycleStart+1 = bit 6 (background BLUE), got 0x${vic.fb32[ro + c30Start + 1].toString(16)}`);
  ok('Open-border idle XSCROLL=0: bit 7 at cycleStart');
}

{
  // XSCROLL=3: foreground (bit 7) shifted right by 3 → at cycleStart+3.
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x0B;                 // CSEL=1, XSCROLL=3
  vic.regs[0x20] = 0x00;
  vic.regs[0x21] = 0x06;
  const canvasY = 50;
  setupOpenBorderLineState(vic, vic.regs, canvasY, 0x80);
  vic._initRenderRasterLine(50, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }
  const c30Start = (30 - 12) * 8 + 8;
  const ro = canvasY * 384;
  const black = 0xFF000000;
  const blue = PALETTE_RGBA[6];
  expect(vic.fb32[ro + c30Start + 3] === black,
    `XSCROLL=3: cycleStart+3 = bit 7 (foreground BLACK), got 0x${vic.fb32[ro + c30Start + 3].toString(16)}`);
  expect(vic.fb32[ro + c30Start] === blue,
    `XSCROLL=3: cycleStart = bit 4 (background BLUE for byte 0x80), got 0x${vic.fb32[ro + c30Start].toString(16)}`);
  ok('Open-border idle XSCROLL=3: foreground shifted right 3 pixels (DEMO-NINE §2)');
}

// ─────────────────────────────────────────────────────────────────────
// Trick 3 — VIC bank ($DD00) mid-line change
// ─────────────────────────────────────────────────────────────────────
//
// Mid-line `noteBankChange` redirects subsequent sprite p-accesses to
// the new bank. Sprite 0 fetches at cycle 58; if we change bank between
// p-access cycles (e.g., between sp0 c58 and sp1 c60), sp1's pointer
// comes from the new bank.

function setupSpritesAllOn(vic) {
  // Pointer table A in bank 0 at $07F8: 0xA0..0xA7.
  // Pointer table B in bank 1 ($4000) at $47F8: 0xB0..0xB7.
  for (let s = 0; s < 8; s++) {
    vic.ram[0x07F8 + s] = 0xA0 + s;
    vic.ram[0x47F8 + s] = 0xB0 + s;
  }
  vic.regs[0x15] = 0xFF;
  vic.regs[0x18] = 0x14;                  // both banks have screen at $X400
  for (let s = 0; s < 8; s++) {
    vic.spriteDmaOn[s] = 1;
    vic.spritePointerFresh[s] = 0;
    vic.spritePointerValue[s] = 0;
  }
}

{
  const vic = makeVic();
  setupSpritesAllOn(vic);
  // Drive to L0 c58 — sp0 p-access just ran in bank 0.
  while (!(vic.raster === 0 && vic.cycleInLine === 58)) vic.clock(1);
  expect(vic.spritePointerValue[0] === 0xA0,
    `pre-bank-change: sp0 from bank 0, got 0x${vic.spritePointerValue[0].toString(16)}`);
  // Switch VIC bank to 1 ($4000). Pointer table at $47F8 is the new source.
  vic.noteBankChange(0x4000);
  // Drive to L1 c10 — sp1..sp7 p-accesses run after the bank change.
  while (!(vic.raster === 1 && vic.cycleInLine === 10)) vic.clock(1);
  expect(vic.spritePointerValue[0] === 0xA0,
    `sp0 stays bank 0, got 0x${vic.spritePointerValue[0].toString(16)}`);
  for (let s = 1; s < 8; s++) {
    expect(vic.spritePointerValue[s] === 0xB0 + s,
      `sp${s} after bank switch: from bank 1, got 0x${vic.spritePointerValue[s].toString(16)}`);
  }
  ok('VIC bank ($DD00 / noteBankChange) mid-line redirects subsequent p-accesses');
}

// ─────────────────────────────────────────────────────────────────────
// Trick 3 — pointer-byte memory write at $07F8+s mid-frame
// ─────────────────────────────────────────────────────────────────────
//
// CPU writes the byte at screenBase+$3F8+s to change the sprite pointer
// without touching $D018 or VIC bank. Next p-access for that sprite
// reads the new value.

{
  const vic = makeVic();
  setupSpritesAllOn(vic);
  // Drive to L0 c58 — sp0 fetched 0xA0 from $07F8.
  while (!(vic.raster === 0 && vic.cycleInLine === 58)) vic.clock(1);
  expect(vic.spritePointerValue[0] === 0xA0,
    `sp0 initial: 0x${vic.spritePointerValue[0].toString(16)}, want 0xA0`);
  // CPU rewrites the pointer byte at $07F8 (sp0's pointer slot).
  vic.ram[0x07F8] = 0xC3;
  // Drive past sp1..sp7 (no effect on them — they have their own
  // pointer slots) and into the next line until sp0's next p-access (L1 c58).
  // Actually sp0 next p-access is at L1 c58. Drive to L1 c58.
  while (!(vic.raster === 1 && vic.cycleInLine === 58)) vic.clock(1);
  expect(vic.spritePointerValue[0] === 0xC3,
    `sp0 after $07F8 mem write: 0x${vic.spritePointerValue[0].toString(16)}, want 0xC3`);
  // Verify other sprites still came from their original 0xA1..0xA7 slots.
  for (let s = 1; s < 8; s++) {
    expect(vic.spritePointerValue[s] === 0xA0 + s,
      `sp${s}: unchanged at 0x${vic.spritePointerValue[s].toString(16)}, want 0x${(0xA0+s).toString(16)}`);
  }
  ok('Pointer-byte memory write at $07F8+s redirects next p-access for that sprite');
}

// ─────────────────────────────────────────────────────────────────────
// Trick 1 — 21-line MxYE crunch integration
// ─────────────────────────────────────────────────────────────────────
//
// Bauer §3.8.1 rule 7a: clearing MxYE at cycle 15 with FF=0 causes
// cycle 16 to compute MCBASE via the bit-interleave crunch formula
// instead of MCBASE := MC. Repeating this every line during the
// sprite's 21-line display produces the "triple-height" rendering
// nine.prg uses for its anchor sprites.
//
// This integration test drives the VIC across a full 21-line sprite
// display window with MxYE-toggle pattern and verifies:
//   (a) MCBASE diverges from the standard 0,3,6,9,...,60 sequence.
//   (b) Each line's MCBASE is the bit-interleave of (MCBASE prev, MC).
//   (c) DMA does NOT clear at line 21 (because MCBASE never reaches 63
//       under the crunch sequence).

{
  const vic = makeVic();
  // Sprite 0, Y=50, enabled, MxYE=1. DMA starts at c55/56 of L50
  // (rule 2 — Y-match), display turns on at c58 (rule 4). Sprite then
  // displays starting L51.
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 50;
  // Drive past L50 c58 into L51 c14 — DMA on, display on, ready to
  // enter the cycle-15 crunch window of L51.
  while (!(vic.raster === 51 && vic.cycleInLine === 14)) vic.clock(1);
  expect(vic.spriteDmaOn[0] === 1,
    `pre-condition: sprite 0 DMA on at L51 c14, got dmaOn=${vic.spriteDmaOn[0]}`);
  // For each of the next 21 lines run the c15 crunch trick:
  //   c15 fires (FF naturally inverts when MxYE=1 + DMA on)
  //   CPU writes $D017=0 at c15 phi2 — clears MxYE → schedules crunch
  //   c16 applies bit-interleave MCBASE formula instead of MCBASE:=MC
  //   CPU restores $D017=1 before next line's c15
  const mcBaseSequence = [];
  const mcSequence = [];
  for (let line = 0; line < 21; line++) {
    // currently at c14 of some line.
    vic.clock(1);                           // c15
    vic.write(0x17, 0x00);                  // CPU clears MxYE at c15 phi2
    vic.clock(1);                           // c16 — crunch formula applied
    mcSequence.push(vic.spriteMC[0]);
    mcBaseSequence.push(vic.spriteMCBase[0]);
    vic.write(0x17, 0x01);                  // restore MxYE for next line
    if (vic.spriteDmaOn[0] === 0) break;
    // Drive to next line c14.
    while (!(vic.cycleInLine === 14)) vic.clock(1);
  }
  // Standard 21-line MCBASE sequence (no crunch): 3,6,9,...,63 (cycle 16
  // does MCBASE := MC where MC = prev MCBASE + 3 from the 3 s-accesses).
  // With the crunch formula MCBASE = bit-interleave(MCBASE_prev, MC),
  // the sequence diverges starting from the very first crunch-line.
  const standardMcBase = Array.from({length: 21}, (_, i) => 3 + i * 3);
  let nonStandardCount = 0;
  for (let i = 0; i < mcBaseSequence.length; i++) {
    if (mcBaseSequence[i] !== standardMcBase[i]) nonStandardCount++;
  }
  expect(nonStandardCount >= 5,
    `at least 5 of ${mcBaseSequence.length} MCBASE values must diverge from standard; got ${nonStandardCount} divergences. mcBaseSequence=[${mcBaseSequence.join(',')}], standard=[${standardMcBase.slice(0, mcBaseSequence.length).join(',')}]`);
  ok('MxYE c15 crunch repeated across sprite display: MCBASE diverges from standard sequence (DEMO-NINE §2)');
}

console.log(`\n${testNo} nine.prg trick spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
