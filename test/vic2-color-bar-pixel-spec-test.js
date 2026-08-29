// Mid-line color-register raster bar PIXEL spec test.
//
// Bauer §3.5 + §3.9: $D020 (border) and $D021 (bg0) are read LIVE per
// pixel by the renderer. A CPU write at PHI2 of cycle N makes the new
// colour visible from canvas-X = (N - 11) * 8 onward (= pixel 0 of the
// cycle FOLLOWING the write; 8565 has +1-cycle pipeline delay).
//
// Demos commonly write $D020/$D021 multiple times per line to produce
// horizontal colour bars. The boundaries are pixel-precise — a 1-cycle
// drift in when the new register value is sampled is visible as an
// 8-pixel shift in the bar edge.
//
// Coverage gap audit (2026-05-18): rated "Color-register raster bars" — ✗
// before this file. grey-dot-spec-test.js covers the 8565 grey-dot
// artifact at the boundary; THIS file locks the BAR EDGE POSITION on
// 6569 across $D020 and $D021 with multiple transitions per line.

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

// Canvas X of cycle C's first pixel (inner-display segments start at c=12).
function cycleCanvasX(cycle) { return (cycle - 12) * 8 + 8; }

// Border-timed boundary: the first canvas X that shows the value which
// landed in lineCycleRegs[R]. $D021-$D024 are OUTPUT-STAGE colour registers
// with NO 12px graphics-data delay, so a mid-line write changes the bg at
// the SAME beam position a $D020 (border) write would — pixel x ← lcr[
// (x+111)>>3] (the calibrated _recolorBorderRow map). Inverting: the first
// x with (x+111)>>3 === R is 8R−111. A CPU write at cy N PHI2 lands in
// lcr[N+1], so its boundary is bgBoundaryX(N+1). Validated against VICE/6569
// (testprogs/VICII/spriteenable "stable line from X to Y").
function bgBoundaryX(R) { return 8 * R - 111; }

// ── 1: Single mid-line $D021 change creates one bar boundary.
// Write at cy 30 PHI2 lands in lcr[31] → bg changes at x = bgBoundaryX(31).
//
// Setup: text mode, idle byte (no display active) so bg fills the
// inner-display region. Drive a real raster line (raster 100, far from
// any bad-line). With idle bytes the renderer paints bg0.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;       // DEN=1, RSEL=1, text mode
  vic.regs[0x16] = 0x08;       // CSEL=1
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x00;       // border = black
  vic.regs[0x21] = 0x06;       // initial bg = blue
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 100 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  // Walk to cycle 30, then write $D021=$02 (red) at PHI2 of cy 30.
  while (!(vic.raster === 100 && vic.cycleInLine === 30)) vic.clock(1);
  vic.write(0x21, 0x02);
  while (!(vic.raster === 101 && vic.cycleInLine === 1)) vic.clock(1);

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;

  // Sample well clear of the boundary: blue before, red after.
  const xPre = cycleCanvasX(20) + 4;     // mid of cycle 20
  const xPost = cycleCanvasX(40) + 4;    // mid of cycle 40
  expect(vic.fb32[ro + xPre] === PAL(0x06),
    `pre-write inner pixel cy20: expected blue ($06), got 0x${vic.fb32[ro + xPre].toString(16)}`);
  expect(vic.fb32[ro + xPost] === PAL(0x02),
    `post-write inner pixel cy40: expected red ($02), got 0x${vic.fb32[ro + xPost].toString(16)}`);
  // Boundary precision (border-timed): last blue pixel then first red pixel
  // at bgBoundaryX(31) — the SAME pixel a $D020 write at cy30 would change
  // (cf. test 3 + _recolorBorderRow). NOT cycleCanvasX(31): the old "visible
  // from cy31 pixel 0" model wrongly inherited the 12px graphics delay.
  const boundaryX = bgBoundaryX(31);
  expect(vic.fb32[ro + boundaryX - 1] === PAL(0x06),
    `boundary pre (x${boundaryX - 1}): expected blue, got 0x${vic.fb32[ro + boundaryX - 1].toString(16)}`);
  expect(vic.fb32[ro + boundaryX] === PAL(0x02),
    `boundary post (x${boundaryX}): expected red, got 0x${vic.fb32[ro + boundaryX].toString(16)}`);
  ok('mid-line $D021 write @ cy30 → bg changes at the border-timed boundary (output-stage, no graphics delay)');
}

// ── 2: Two mid-line $D021 changes → three distinct horizontal bands.
// Demos often produce N-band copper-bar effects with cycle-counted IRQ
// chains. This locks the pixel position of TWO boundaries simultaneously.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x00;
  vic.regs[0x21] = 0x06;       // blue
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 100 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 100 && vic.cycleInLine === 20)) vic.clock(1);
  vic.write(0x21, 0x02);       // red @ cy20 phi2 → visible from cy21
  while (!(vic.raster === 100 && vic.cycleInLine === 40)) vic.clock(1);
  vic.write(0x21, 0x05);       // green @ cy40 phi2 → visible from cy41
  while (!(vic.raster === 101 && vic.cycleInLine === 1)) vic.clock(1);

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  // Sample mid-cycle pixels across the three bands.
  const blueX  = cycleCanvasX(15) + 4;    // band 1 (blue, cy ≤20)
  const redX   = cycleCanvasX(30) + 4;    // band 2 (red, cy 21-40)
  const greenX = cycleCanvasX(50) + 4;    // band 3 (green, cy ≥41)
  expect(vic.fb32[ro + blueX] === PAL(0x06),
    `band 1 (cy15): expected blue, got 0x${vic.fb32[ro + blueX].toString(16)}`);
  expect(vic.fb32[ro + redX] === PAL(0x02),
    `band 2 (cy30): expected red, got 0x${vic.fb32[ro + redX].toString(16)}`);
  expect(vic.fb32[ro + greenX] === PAL(0x05),
    `band 3 (cy50): expected green, got 0x${vic.fb32[ro + greenX].toString(16)}`);
  // Border-timed boundary precision: blue→red at bgBoundaryX(21), red→green
  // at bgBoundaryX(41) — the same pixels $D020 writes at cy20/cy40 would hit.
  const b1 = bgBoundaryX(21), b2 = bgBoundaryX(41);
  expect(vic.fb32[ro + b1 - 1] === PAL(0x06), `b1 pre (x${b1 - 1}): blue`);
  expect(vic.fb32[ro + b1] === PAL(0x02), `b1 post (x${b1}): red`);
  expect(vic.fb32[ro + b2 - 1] === PAL(0x02), `b2 pre (x${b2 - 1}): red`);
  expect(vic.fb32[ro + b2] === PAL(0x05), `b2 post (x${b2}): green`);
  ok('two mid-line $D021 writes → 3-band raster bar with border-timed boundaries');
}

// ── 3: Mid-line $D020 change → border colour bar.
// Border bars (Δ$D020) are a common demo effect. They affect the side-
// border regions outside the inner display (CSEL=1 → X<32 and X≥352).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x0E;       // initial border = light blue
  vic.regs[0x21] = 0x06;
  vic.displayEnabled = true;

  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 100 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  // Border at cy 0-13 (left) is closed. Write $D020 mid-line so the
  // right border (cy ≥56) paints the new colour.
  while (!(vic.raster === 100 && vic.cycleInLine === 50)) vic.clock(1);
  vic.write(0x20, 0x02);       // red @ cy 50 phi2 → visible from cy 51
  while (!(vic.raster === 101 && vic.cycleInLine === 1)) vic.clock(1);

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;

  // Left border (canvas X=10, well before cy51) = pre-write light blue.
  expect(vic.fb32[ro + 10] === PAL(0x0E),
    `left border pre-write: expected light blue ($0E), got 0x${vic.fb32[ro + 10].toString(16)}`);
  // Right border (canvas X=370, after cy56 right-set + post-write) = red.
  expect(vic.fb32[ro + 370] === PAL(0x02),
    `right border post-write: expected red ($02), got 0x${vic.fb32[ro + 370].toString(16)}`);
  ok('Bauer §3.5: mid-line $D020 write changes border colour for subsequent border zones');
}

console.log(`\n${testNo} mid-line color-bar pixel spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
