// Sprite shifter / row-data hygiene across line + frame boundaries.
//
// Nine's "moving up" pattern relies on the sprite shift register and
// row data being CLEAN on every line where the sprite isn't actively
// displaying. If `_endSpriteDisplayLine` leaves stale bytes behind, the
// per-cycle captured `lineCycleSpriteShiftReg` propagates the garbage
// into the renderer on subsequent lines (sprite-X comparator fires →
// shifter walks through whatever bytes are in there → visible pixels).
//
// Bauer §3.8.1 + §3.8.2 (paraphrased + impl invariants):
//
//   - At cycle 58 phi1, when DMA is off, rule 4's "display off" clause
//     fires. Impl: `_endSpriteDisplayLine` clears shiftReg + rowData +
//     rowByteMask + spriteLineDataRow to -1.
//   - Subsequent `_captureCycleState` calls write those cleared values
//     into `lineCycleSpriteShiftReg[c]`, `lineCycleSpriteRowByteMask[c]`,
//     `lineCycleSpriteDataRow[c]`, `lineCycleSpriteDisplayOn[c]`.
//   - The renderer reads ONLY the per-cycle captured state when painting.
//
// What this file pins:
//
//   D1. On the line where display ends naturally (sprite Y=51, ends at
//       L72 c58), the captured per-cycle shifter array is 0 for cycles
//       >= 58. Cycles 1..57 may still hold the previous-row data — that
//       is the line's last row of pixels — but from c58 phi1 the
//       shifter is gone.
//
//   D2. The line AFTER display end (L73) has zero captured shifter for
//       every cycle 1..63 — no residual state.
//
//   D3. With Y=100 and the sprite NEVER having displayed yet (raster
//       has not reached L100), canvas rows L0..L99 paint zero sprite
//       pixels (no stale state from initialization).
//
// Does NOT load nine.prg.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

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
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  return vic;
}

function driveTo(vic, raster, cycle = 1) {
  let safety = 312 * CYCLES_PER_LINE * 4;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
  }
  if (safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
}

function paletteRGBA(idx) {
  const c = C64_PALETTE[idx & 0x0F];
  return (0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)) >>> 0;
}

function loadSp0AllOpaque(vic, colorIdx = 0x07) {
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;
  vic.regs[0x18] = 0x14;
  vic.regs[0x27] = colorIdx;
  return paletteRGBA(colorIdx);
}

function countColorOnRow(vic, canvasY, color) {
  if (canvasY < 0 || canvasY >= vic.fb32.length / CANVAS_W) return -1;
  const ro = canvasY * CANVAS_W;
  let count = 0;
  for (let x = 0; x < CANVAS_W; x++) if (vic.fb32[ro + x] === color) count++;
  return count;
}

// ─── D1: per-cycle shifter capture goes to 0 from c58 onwards on end line ─
//
// Sprite Y=51 displays L52..L72. At L72 c16, MCBASE→63 → DMA off (rule 8).
// At L72 c58 phi1, rule 4's "DMA off → display off" branch fires:
// _endSpriteDisplayLine clears shiftReg to 0. The c58 capture (and all
// subsequent c59..c63 captures) on L72 must show shiftReg=0.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x60;
  vic.regs[0x01] = 51;
  loadSp0AllOpaque(vic, 0x07);

  // Drive to L72 c57 — sprite has displayed L52..L71 + the first half of
  // L72 (rule 7 turned DMA off at L72 c16, but display lingers until c58).
  driveTo(vic, 72, 57);
  expect(vic.spriteDmaOn[0] === 0,
    `pre L72 c58: DMA off at L72 c16 (rule 7)`);
  expect(vic.spriteDisplayOn[0] === 1,
    `pre L72 c58: display still on (rule 4 hasn't fired yet)`);

  // Step through c58 — _endSpriteDisplayLine fires.
  vic.clock(1);                           // c58
  expect(vic.spriteDisplayOn[0] === 0,
    `D1: L72 c58 phi1 — display off (rule 4 DMA-off branch)`);
  expect(vic.spriteShiftReg[0] === 0,
    `D1: L72 c58 phi1 — live shiftReg cleared (got 0x${vic.spriteShiftReg[0].toString(16)})`);

  // Step through to c63 + check captured cycle state.
  driveTo(vic, 72, 62);

  // Captured per-cycle shifter for c58..c62 must all be 0. (cycleInLine
  // wraps c62 → next raster c1; c63 is never observable so we check up
  // through c62.)
  for (let c = 58; c <= 62; c++) {
    expect(vic.lineCycleSpriteShiftReg[c][0] === 0,
      `D1: L72 c${c} captured shifter must be 0, got 0x${vic.lineCycleSpriteShiftReg[c][0].toString(16)}`);
    expect(vic.lineCycleSpriteDisplayOn[c][0] === 0,
      `D1: L72 c${c} captured displayOn must be 0`);
  }
  ok('D1: L72 c58 phi1 clears shifter; per-cycle capture for c58..c63 is 0');
}

// ─── D2: line after display end — captured shifter zero across c1..c63 ──
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x60;
  vic.regs[0x01] = 51;
  loadSp0AllOpaque(vic, 0x07);

  driveTo(vic, 73, 62);
  for (let c = 1; c < CYCLES_PER_LINE; c++) {       // c1..c62 (observable)
    expect(vic.lineCycleSpriteShiftReg[c][0] === 0,
      `D2: L73 c${c} captured shifter must be 0, got 0x${vic.lineCycleSpriteShiftReg[c][0].toString(16)}`);
    expect(vic.lineCycleSpriteRowByteMask[c][0] === 0,
      `D2: L73 c${c} captured rowByteMask must be 0, got 0x${vic.lineCycleSpriteRowByteMask[c][0].toString(16)}`);
    expect(vic.lineCycleSpriteDisplayOn[c][0] === 0,
      `D2: L73 c${c} captured displayOn must be 0`);
  }
  ok('D2: line after display end (L73) — captured shifter/mask/displayOn all 0 across c1..c63');
}

// ─── D3: pre-display lines have zero sprite pixels on canvas ─────────────
//
// Y=100 — DMA latches at L100 c55, display ON L100 c58 onwards. For
// raster < 100, no sprite pixels should appear on the canvas.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x60;
  vic.regs[0x01] = 100;
  const yellowRGBA = loadSp0AllOpaque(vic, 0x07);
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;

  // Drive past L100 c62 to render all rows up to L100.
  driveTo(vic, 100, 62);
  // Canvas rows for L20..L99 (canvasY 5..84): zero sprite pixels.
  let totalYellow = 0;
  for (let r = 20; r <= 99; r++) {
    const cy = r - 15;
    if (cy < 0) continue;
    const n = countColorOnRow(vic, cy, yellowRGBA);
    if (n > 0) {
      currentFailures.push(`D3: raster ${r} (canvasY ${cy}) had ${n} sprite pixels (must be 0)`);
    }
    totalYellow += n;
  }
  expect(totalYellow === 0,
    `D3: pre-display rows L20..L99 must have zero sprite pixels, total=${totalYellow}`);
  ok('D3: sprite Y=100 — canvas rows for L20..L99 have zero sprite pixels (no stale state)');
}

// ─── D4: pre-display lines after a frame wrap — same guarantee ──────────
//
// Run one full frame (sprite displays L52..L72), advance into the next
// frame, and verify that L0..L20 of the NEW frame has zero sprite pixels.
// This rules out stale per-cycle capture surviving the line-init reset
// at `_initRenderRasterLine`.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x60;
  vic.regs[0x01] = 51;
  const yellowRGBA = loadSp0AllOpaque(vic, 0x07);
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;

  // Frame 1: drive through entire 312-line frame.
  driveTo(vic, 311, 62);
  // Frame 2: advance into top zone, render L0..L20.
  driveTo(vic, 21, 1);

  let total = 0;
  for (let r = 0; r <= 20; r++) {
    const cy = r - 15;
    if (cy < 0) continue;
    const n = countColorOnRow(vic, cy, yellowRGBA);
    if (n > 0) {
      currentFailures.push(`D4: raster ${r} (canvasY ${cy}) had ${n} sprite pixels (must be 0)`);
    }
    total += n;
  }
  expect(total === 0,
    `D4: post-frame-wrap top-zone rows L0..L20 must have zero sprite pixels, total=${total}`);
  ok('D4: after frame wrap, top-zone rows L0..L20 have zero sprite pixels');
}

console.log(`\n${testNo} sprite shifter hygiene spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
