// Open-top-border ghost-byte rendering spec audit (DEMO-NINE §7, §8;
// Bauer §3.7.2, §3.7.3, §3.7.5, §3.9).
//
// Nine opens the top vertical border via the DEN=0 trick (Bauer §3.9
// rule 5: top compare clears vBorder only if DEN=1; with DEN cleared
// just before the top-compare-line c63, vBorder stays set; with DEN
// kept SET through the top compare, vBorder is cleared and the open-
// border ghost-byte ($3FFF or $39FF in the current VIC bank) shifts
// out at 1 bit per pixel inside the inner zone (cycles 15..54, canvas
// X 32..351).
//
// User-visible bug: the 2026-05-19 nine.prg screenshot shows dashed
// ghost-byte artifacts above the digit sprites — characteristic of the
// idle shifter painting in a zone where the underlying data is wrong
// (e.g., stale bank, wrong ECM-state when sampled, or the side-zone
// shifter being mis-fed).
//
// What this file pins (strictly spec-derived):
//
//   A2. Idle ghost-byte is only emitted in the INNER zone (canvas X
//       32..351). Open side zones (X 0..31, 352..383) emit bg0, not
//       the idle bit pattern — even when the idle byte itself is
//       non-zero. (Bauer §3.7.2: shifter never loads in side cycles;
//       VICE testprogs/VICII/sb_sprite_fetch ground-truths this.)
//
//   A3. The idle byte VALUE matches the byte at $3FFF (or $39FF when
//       ECM=1) in the current VIC bank. A mid-line ECM flip switches
//       the source per cycle — c15..c19 with ECM=0 reads from $3FFF,
//       c20..c54 with ECM=1 reads from $39FF, and the rendered bit
//       pattern across the canvas reflects which byte fed which cycle
//       slot.
//
// Does NOT load nine.prg. Pure synthetic per-cycle state.

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

// Apply a top-border open state across an entire raster line: vBorder=0,
// hBorder closed in side cycles only, hInner open in c15..54. Caller
// stamps `lineCycleIdleByte` per cycle (so we can test mid-line ECM
// transitions). DEN trick gymnastics are not re-tested here — see
// ghost-byte-border-spec-test.js #11/#12 for that path.
function paintOpenTopBorderLine(vic, idleBytesByCycle) {
  vic.regs[0x11] = 0x1B;     // DEN=1, RSEL=1, YS=3 (defaults; ECM=0)
  vic.regs[0x16] = 0x08;     // CSEL=1, XSCROLL=0
  vic.regs[0x20] = 0x0E;     // border = light blue
  vic.regs[0x21] = 0x06;     // bg0 = blue
  // Mirror what _beginRasterLine would have captured at cy 1 of this
  // line. This synthetic setup bypasses the normal clock path, so the
  // line-start scalars (used by impl-detail invariants in
  // _renderOpenBorderIdleSpan and _isDisplayColumnPhase) must be seeded
  // explicitly to match the test's intended steady-state $D011.
  vic._lineStartD011 = vic.regs[0x11];
  vic._lineStartD021 = vic.regs[0x21];
  vic._prevLineStartD011 = vic.regs[0x11];
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    // hBorder closed in the canvas side zones. Per the cycle→canvas-X
    // mapping (canvas X (c-12)*8+8), c11..c14 → X 0..31 (left side),
    // c55..c58 → X 352..383 (right side). hInner is the inner zone
    // c15..c54 → X 32..351. The full right side closes at c55, not c56.
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 55) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = 0;       // open-border idle, no c-data
    vic.lineCycleDisplayActive[c] = 0;
    vic.lineCycleDisplayEnabled[c] = 1;
    vic.lineCycleBanks[c] = 0x0000;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = idleBytesByCycle[c] ?? 0x00;
  }
}

// ─── A2: idle byte renders ONLY in the inner zone (c15..54) ─────────────
//
// Nine's real configuration: top vBorder opened by DEN trick, side
// borders kept CLOSED (left/right border-FF set). Inner zone shows the
// ghost-byte bit pattern; side zones show border color ($D020). This
// matches the user's 2026-05-19 screenshot exactly: BLACK side edges,
// dashed ghost-byte across the inner top band.
//
// Spec source: Bauer §3.9 — main border FF gates the $D020 overlay; the
// shifter is loaded only in c15..54 (Bauer §3.7.2). With sides closed,
// X 0..31 and X 352..383 are unconditionally border color regardless of
// what's in the idle shifter.
{
  const vic = makeVic();
  const idle = new Uint8Array(CYCLES_PER_LINE + 1).fill(0xFF);  // all-ones idle
  paintOpenTopBorderLine(vic, idle);
  const canvasY = 20;                                  // top-border zone
  vic._initRenderRasterLine(20, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }

  const ro = canvasY * CANVAS_W;
  const borderRGBA = PALETTE_RGBA[0x0E];     // light blue $D020
  const fgBlack = 0xFF000000;

  // Left side zone (canvas X 0..31): border color (sides still closed).
  let leftBorder = 0;
  for (let x = 0; x < 32; x++) if (vic.fb32[ro + x] === borderRGBA) leftBorder++;
  expect(leftBorder === 32,
    `A2: closed left side (X 0..31) must be border color (got ${leftBorder}/32 border px)`);

  // Right side zone (canvas X 352..383): border color.
  let rightBorder = 0;
  for (let x = 352; x < CANVAS_W; x++) if (vic.fb32[ro + x] === borderRGBA) rightBorder++;
  expect(rightBorder === 32,
    `A2: closed right side (X 352..383) must be border color (got ${rightBorder}/32 border px)`);

  // Inner zone (canvas X 32..351) with idle=$FF in text mode: every
  // pixel fg=BLACK. Confirms the ghost byte IS rendering only here.
  let innerBlack = 0;
  for (let x = 32; x < 352; x++) if (vic.fb32[ro + x] === fgBlack) innerBlack++;
  expect(innerBlack === 320,
    `A2 control: inner zone X 32..351 with idle=$FF text mode must be all BLACK (got ${innerBlack}/320)`);
  ok('A2: open top-border ghost byte emits ONLY in inner zone (c15..54); closed sides = border color');
}

// ─── A3a: idle byte VALUE = byte at $3FFF (ECM=0) ────────────────────────
//
// Bauer §3.7.3 + §3.7.5: the idle g-access reads from $3FFF in the
// current VIC bank when ECM=0. Plant a known byte and verify the
// rendered bit pattern matches.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;                     // ECM=0
  vic.ram[0x3FFF] = 0xAA;                    // 10101010

  const idle = new Uint8Array(CYCLES_PER_LINE + 1);
  for (let c = 15; c <= 54; c++) {
    idle[c] = vic._readIdleGByte(vic.regs, 0);
  }
  paintOpenTopBorderLine(vic, idle);

  const canvasY = 20;
  vic._initRenderRasterLine(20, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }

  // Sample one cycle's 8 pixels (c30 → canvas X (30-12)*8+8 = 152).
  // idle=$AA = 10101010. Text-mode idle: bit=1 → fg (BLACK), bit=0 → bg0.
  const ro = canvasY * CANVAS_W;
  const cycleStart = (30 - 12) * 8 + 8;
  const bg0 = PALETTE_RGBA[0x06];
  const fgBlack = 0xFF000000;

  for (let bit = 0; bit < 8; bit++) {
    const px = vic.fb32[ro + cycleStart + bit];
    const expectFg = (0xAA >> (7 - bit)) & 1;
    const expected = expectFg ? fgBlack : bg0;
    expect(px === expected,
      `A3a: ECM=0 idle from $3FFF=$AA — X ${cycleStart + bit} expected ${expectFg ? 'fg-BLACK' : 'bg0'}, got 0x${px.toString(16)}`);
  }
  ok('A3a: open top-border idle byte = ($3FFF) byte content when ECM=0');
}

// ─── A3b: ECM=1 switches idle source to $39FF ────────────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x5B;                     // ECM=1, RSEL=1, DEN=1, YS=3
  vic.ram[0x3FFF] = 0xFF;                    // would be wrong if path leaks
  vic.ram[0x39FF] = 0x55;                    // 01010101

  const idle = new Uint8Array(CYCLES_PER_LINE + 1);
  for (let c = 15; c <= 54; c++) idle[c] = vic._readIdleGByte(vic.regs, 0);
  paintOpenTopBorderLine(vic, idle);
  // paintOpenTopBorderLine overwrote regs back to ECM=0; restore for the
  // per-cycle ECM-1 capture (otherwise the per-cycle regs say ECM=0 even
  // though we read $39FF — fine for the bit pattern but inconsistent for
  // the rendering mode dispatch). Refresh per-cycle regs:
  vic.regs[0x11] = 0x5B;
  for (let c = 0; c <= CYCLES_PER_LINE; c++) vic.lineCycleRegs[c].set(vic.regs);

  const canvasY = 20;
  vic._initRenderRasterLine(20, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }

  // ECM=1 with BMM=0 MCM=0 = ECM-only text. In OPEN-BORDER IDLE the
  // c-data is implicitly 0 (no g-access matrix data), so the rendering
  // mode is `modeCode=0` (standard bit-driven). idle=$55 → pixels
  // alternate bg0/fg/bg0/fg.
  const ro = canvasY * CANVAS_W;
  const cycleStart = (30 - 12) * 8 + 8;
  const bg0 = PALETTE_RGBA[0x06];
  const fgBlack = 0xFF000000;
  for (let bit = 0; bit < 8; bit++) {
    const px = vic.fb32[ro + cycleStart + bit];
    const expectFg = (0x55 >> (7 - bit)) & 1;
    const expected = expectFg ? fgBlack : bg0;
    expect(px === expected,
      `A3b: ECM=1 idle from $39FF=$55 — X ${cycleStart + bit} expected ${expectFg ? 'fg-BLACK' : 'bg0'}, got 0x${px.toString(16)}`);
  }
  ok('A3b: ECM=1 redirects open top-border idle source to $39FF');
}

// ─── A3c: mid-line ECM flip switches idle source per cycle ───────────────
//
// Nine flips $D011 between $1B/$1D (ECM=0) and $70/$73 (ECM=1) mid-line.
// Per Bauer §3.7.3 + §3.7.5 the idle-source decision is made per
// g-access (= per cycle), so the rendered bit pattern in adjacent cycle
// slots can reflect different idle bytes.
//
// Setup: $3FFF=$00 (ECM=0 reads → all bg0), $39FF=$FF (ECM=1 reads →
// all fg-BLACK in text mode). Cycle 15..29 use ECM=0 idle, cycle 30..54
// use ECM=1 idle.
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0x00;
  vic.ram[0x39FF] = 0xFF;
  vic.regs[0x11] = 0x1B;                     // start ECM=0
  vic.regs[0x16] = 0x08;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;

  const idle = new Uint8Array(CYCLES_PER_LINE + 1);
  // Read each cycle's idle byte at the time-of-fetch ECM state.
  for (let c = 15; c <= 29; c++) {
    vic.regs[0x11] = 0x1B;                   // ECM=0
    idle[c] = vic._readIdleGByte(vic.regs, 0);
  }
  for (let c = 30; c <= 54; c++) {
    vic.regs[0x11] = 0x5B;                   // ECM=1
    idle[c] = vic._readIdleGByte(vic.regs, 0);
  }
  // Verify the captured idle bytes diverge.
  expect(idle[20] === 0x00, `pre: c20 idle=$00 from ECM=0 read of $3FFF`);
  expect(idle[40] === 0xFF, `pre: c40 idle=$FF from ECM=1 read of $39FF`);

  // Match per-cycle regs to the per-cycle ECM state so the renderer
  // mode-dispatch is consistent.
  paintOpenTopBorderLine(vic, idle);
  for (let c = 15; c <= 29; c++) {
    vic.lineCycleRegs[c][0x11] = 0x1B;
  }
  for (let c = 30; c <= 54; c++) {
    vic.lineCycleRegs[c][0x11] = 0x5B;
  }

  const canvasY = 20;
  vic._initRenderRasterLine(20, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }

  const ro = canvasY * CANVAS_W;
  const bg0 = PALETTE_RGBA[0x06];
  const fgBlack = 0xFF000000;

  // c20 (canvas X (20-12)*8+8=72..79) all bg0 (idle=$00).
  let c20Bg = 0;
  for (let x = 72; x < 80; x++) if (vic.fb32[ro + x] === bg0) c20Bg++;
  expect(c20Bg === 8,
    `A3c: c20 ECM=0 idle=$00 → 8 bg0 pixels (got ${c20Bg})`);

  // c40 (canvas X (40-12)*8+8=232..239) all fg-BLACK (idle=$FF text mode).
  let c40Fg = 0;
  for (let x = 232; x < 240; x++) if (vic.fb32[ro + x] === fgBlack) c40Fg++;
  expect(c40Fg === 8,
    `A3c: c40 ECM=1 idle=$FF → 8 fg-BLACK pixels (got ${c40Fg})`);
  ok('A3c: mid-line ECM flip switches idle source per cycle (c15..29 ECM=0, c30..54 ECM=1)');
}

console.log(`\n${testNo} open-top-border ghost-byte spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
