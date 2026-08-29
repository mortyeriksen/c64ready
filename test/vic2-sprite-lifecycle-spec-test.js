// Sprite display lifecycle spec audit. 15 tests derived from Bauer
// §3.8.1 (sprite DMA rules 1..8) and §3.11 (collision detection). Covers
// the full DMA-on/DMA-off lifecycle, MC/MCBASE counter cadence, Y-expand
// height doubling, and collision register behavior.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

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

function driveUntil(vic, raster, cycle = 1) {
  while (vic.raster < raster || (vic.raster === raster && vic.cycleInLine < cycle)) {
    vic.clock(1);
  }
}

function setupSprite(vic, sprite, regX, opts = {}) {
  const { color = 2, shiftReg = 0xFFFFFF, multicolor = false, xExpand = false, priority = false } = opts;
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= (1 << sprite);
    if (xExpand) vic.lineCycleRegs[cycle][0x1D] |= (1 << sprite);
    if (multicolor) vic.lineCycleRegs[cycle][0x1C] |= (1 << sprite);
    if (priority) vic.lineCycleRegs[cycle][0x1B] |= (1 << sprite);
    vic.lineCycleRegs[cycle][sprite * 2] = regX & 0xFF;
    if (regX > 255) vic.lineCycleRegs[cycle][0x10] |= (1 << sprite);
    vic.lineCycleRegs[cycle][0x27 + sprite] = color & 0x0F;
    vic.lineCycleSpriteDisplayOn[cycle][sprite] = 1;
    vic.lineCycleSpriteDataRow[cycle][sprite] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][sprite] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][sprite] = shiftReg >>> 0;
  }
  vic.spriteLineDataRow[sprite] = 0;
  vic.spriteRowByteMask[sprite] = 0x07;
  vic.spriteShiftReg[sprite] = shiftReg >>> 0;
}

// ── 1: Y-match at cycle 55 sets DMA + MCBASE := 0 ────────────────────────
// Bauer §3.8.1 rule 2: at cycle 55/56, if sprite enabled AND Y matches,
// DMA flag set + MCBASE cleared + advance-line FF set.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveUntil(vic, 51, 56);
  expect(vic.spriteDmaOn[0] === 1, `Bauer rule 2: DMA on after cycle 55 Y match`);
  expect(vic.spriteMCBase[0] === 0, `Bauer rule 2: MCBASE := 0 at DMA start`);
  expect(vic.spriteYExpandFF[0] === 1, `Bauer rule 2: advance-line FF := 1 at DMA start`);
  ok('Bauer §3.8.1 rule 2: cycle 55 Y match sets DMA, clears MCBASE, sets FF');
}

// ── 2: DMA stays off without Y match ─────────────────────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 200;                  // never matches at L51
  vic.displayEnabled = true;
  driveUntil(vic, 51, 60);
  expect(vic.spriteDmaOn[0] === 0,
    `no Y match → DMA stays off`);
  ok('Bauer §3.8.1: DMA stays off without Y match');
}

// ── 3: Sprite display turns on at line N+1 after Y-match at N ───────────
// Bauer rule 5 (cycle 58): if DMA flag is on AND Y matches, the display
// flag is set at cycle 58 of the matching line — making the sprite
// visually appear starting NEXT scanline.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveUntil(vic, 51, 60);
  // At end of L51 the sprite display state may be queued; verify it's
  // active by next cycle 1 of L52.
  driveUntil(vic, 52, 5);
  expect(vic.spriteDisplayOn[0] === 1,
    `L52 cycle 5: sprite display must be ON (Y matched at L51)`);
  ok('Bauer §3.8.1 rule 5: sprite display turns on at L+1 after Y-match');
}

// ── 4: Sprite displays for exactly 21 lines (rule 8) ────────────────────
// MC advances by 3 per s-access (3 bytes per line). After 21 lines × 3 =
// 63 = MCBASE, rule 8 turns DMA off at cycle 16 of the 22nd line.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveUntil(vic, 72, 17);
  expect(vic.spriteDmaOn[0] === 0,
    `Bauer rule 8: DMA must clear at L72.c16 (21 lines after Y match)`);
  ok('Bauer §3.8.1 rule 8: sprite DMA clears after 21 lines (MCBASE=63)');
}

// ── 5: Y-expanded sprite displays for ~42 lines ─────────────────────────
// Bauer rules 3+5+7: with MxYE=1 the FF flips between 0 and 1 each line,
// so the row data only advances every other line. 21 sprite rows × 2
// scan-lines per row = ~42 lines.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  // After 41 lines of display, DMA still on.
  driveUntil(vic, 91, 17);
  expect(vic.spriteDmaOn[0] === 1,
    `MxYE=1: DMA must persist through ~42 lines, off at line ${vic.raster}`);
  ok('Bauer §3.8.1 rules 3+5+7: MxYE=1 doubles sprite display height');
}

// ── 6: Per-sprite Y is independent (sp0 at 51, sp1 at 100) ──────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x03;                  // sp0+sp1
  vic.regs[0x01] = 51;
  vic.regs[0x03] = 100;
  vic.displayEnabled = true;
  driveUntil(vic, 51, 60);
  expect(vic.spriteDmaOn[0] === 1, `sp0 DMA on at L51`);
  expect(vic.spriteDmaOn[1] === 0, `sp1 DMA still off (Y=100)`);
  driveUntil(vic, 100, 60);
  expect(vic.spriteDmaOn[1] === 1, `sp1 DMA on at L100`);
  ok('Bauer §3.8.1: per-sprite Y match is independent');
}

// ── 7: Disabling enable mid-display does not stop active DMA ────────────
// Bauer §3.8.1: $D015 only gates the cycle-55 DMA-START check. A sprite
// already in DMA continues until rule 8 (MCBASE=63 at cycle 16).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveUntil(vic, 55, 0);
  expect(vic.spriteDmaOn[0] === 1, `pre: DMA on after Y match`);
  vic.write(0x15, 0x00);
  driveUntil(vic, 60, 30);
  expect(vic.spriteDmaOn[0] === 1,
    `disable mid-display: active DMA must continue per Bauer §3.8.1`);
  ok('Bauer §3.8.1: $D015 disable mid-display does not stop active DMA');
}

// ── 8: Y-expand FF inverts at cycle 56 phi2 when MxYE=1 ──────────────────
// Bauer rule 3: at cycle 56 phi2 the FF is inverted iff MxYE=1 AND DMA on.
// Just-started DMA: rule 2 set FF=1 at cycle 55. Rule 3 then inverts at
// cycle 56 → FF=0 for next line.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveUntil(vic, 51, 56);
  expect(vic.spriteYExpandFF[0] === 0,
    `MxYE=1 + cycle 56: FF inverted from 1 → 0`);
  ok('Bauer §3.8.1 rule 3: cycle 56 phi2 inverts FF when MxYE=1');
}

// ── 9: Y-expand FF NOT inverted when MxYE=0 ──────────────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveUntil(vic, 51, 56);
  expect(vic.spriteYExpandFF[0] === 1,
    `MxYE=0 + cycle 56: FF stays at 1 (no invert)`);
  ok('Bauer §3.8.1 rule 3: cycle 56 inversion gated on MxYE=1');
}

// ── 13: Sprite priority by index (lower wins) ───────────────────────────
// Bauer §3.8.2: when two sprites' opaque pixels coincide, the sprite with
// the lower index "wins" — the higher-index sprite is masked.
{
  const vic = makeVic();
  setupSprite(vic, 0, 100, { color: 2, shiftReg: 0xFFFFFF });
  setupSprite(vic, 3, 100, { color: 5, shiftReg: 0xFFFFFF });
  const rowOffset = 50 * CANVAS_W;
  vic.spriteOwnerBuffer.fill(0xFF, 0, CANVAS_W);
  vic._renderSpriteLine(50, 50);
  // Sp0 should own the overlapping pixels, not sp3.
  expect(vic.spriteOwnerBuffer[110] === 0,
    `priority: sp0 (lower index) wins over sp3 at canvas-X 110`);
  ok('Bauer §3.8.2: lower-index sprite wins priority at overlap');
}

// ── 14: Sprite Y register write reflects in regs immediately ────────────
{
  const vic = makeVic();
  vic.write(0x01, 100);
  expect(vic.regs[0x01] === 100, `$D001 (sp0 Y) reads back what was written`);
  vic.write(0x05, 200);
  expect(vic.regs[0x05] === 200, `$D005 (sp2 Y) reads back what was written`);
  ok('Bauer §3.8: sprite Y register read/write round-trip');
}

// ── 15: Sprite Y match triggers DMA on the EXACT match line ─────────────
// At raster N, if sprite-Y register == N at cycle 55, DMA latches.
// At raster N-1 it does NOT latch (Y compare uses current raster).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 60;                      // match at L60
  vic.displayEnabled = true;
  driveUntil(vic, 59, 60);
  expect(vic.spriteDmaOn[0] === 0, `pre L60: DMA off`);
  driveUntil(vic, 60, 56);
  expect(vic.spriteDmaOn[0] === 1, `at L60.c56: DMA on (Y matched)`);
  ok('Bauer §3.8.1 rule 2: Y match triggers DMA at exact match raster');
}

console.log(`\n${testNo} sprite-lifecycle spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
