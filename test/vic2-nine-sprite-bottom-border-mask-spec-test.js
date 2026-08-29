// Sprite pixel masking at vertical-border boundaries — Nine "moving up"
// regression coverage.
//
// Nine animates its 9 digit sprites by changing Y between frames. As Y
// decreases, the sprite display window walks UP the screen — eventually
// crossing the top compare (entering the top border) or via raster
// wrap from the bottom edge. Each frame's sprite render must:
//
//   (a) paint only where the border-FF is OPEN (borderBuffer === 0).
//   (b) NOT leak pixels into the vertical-border zone when the demo
//       hasn't opened it via the DEN trick.
//
// Bauer §3.9: when vBorderActive is set, every pixel of the line is
// border color — sprites are gated out by the rendering's borderBuffer
// fill (see vic2.js:_renderRasterLine — borderBuffer.fill(1, …) when
// hBorder closed, and §3.14.1 Method 1 fill when vBorder set + hBorder
// open: the segment fills bg0 across the sprite zone). The sprite shift
// register continues advancing (§3.8.1 rules 6+7 — DMA/MC don't gate
// on border-FF), but no pixels reach the canvas.
//
// What this file pins:
//
//   B2. Sprite with Y in the lower display zone (Y=240) paints into
//       canvas rows L241..L250 (display zone), but NOT into L251..L261
//       (bottom-border zone). vBorderActive becomes 1 at L251 c63 via
//       rule 4; on L251 itself the canvas row is mostly closed-border;
//       on L252+ every pixel is masked.
//
//   B3. Sprite whose Y matches raster 311 (Y=55 since 311 & 0xFF = 55,
//       enabled only just before L311 c55 so the L55 match misses) has
//       its display straddle the 311→0 wrap. Display ON at L0 c58 (per
//       rule 4). L0..L20 are in the top vertical border (vBorderActive=1
//       from L251 of the previous frame onwards). No sprite pixels must
//       leak onto the canvas.
//
// Both tests use the live VIC clock and check the framebuffer after
// rendering. No PRG loaded.

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
  vic.regs[0x11] = 0x1B;             // DEN=1, RSEL=1, YS=3
  vic.regs[0x16] = 0x08;             // CSEL=1
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

// Sprite 0 = solid 24×21 yellow at $2000.
function loadSp0AllOpaque(vic, colorIdx = 0x07) {
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;
  vic.regs[0x18] = 0x14;             // screen base $0400 (clear of CHARROM shadow)
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

// canvasY = raster - 15 (PAL mapping used throughout the engine; see
// ghost-byte-border-spec-test #1, sprite-corner-cases #1, etc.).
function rasterToCanvasY(raster) {
  return raster - 15;
}

// ─── B2: sprite at Y=240 paints display rows L241..L250 only ─────────────
//
// Sprite Y=240 → DMA latches at L240 c55 (rule 2), display turns on at
// L241 c58 (rule 4). 21-line display L241..L261 spans the bottom of
// the display zone and continues into the bottom border zone (vBorder
// SET at L251 c63 per rule 4). Sprite pixel masking should:
//   - Paint sprite color on canvas rows for L241..L250 (vBorder=0).
//   - L251 c63 SETs vBorder → the entire L252+ raster is border. The
//     L251 itself is a boundary line: rule 4 fires at c63, so vBorder
//     is 0 across the c-render cycles 11..62 (with the latch at c63
//     phi1 setting it). Per impl, the canvas row for L251 may show
//     sprite pixels in cycles 11..62, mask in c63's pixel slot.
//   - L252..L261 must have zero sprite-color pixels — vBorder set
//     across the entire line means borderBuffer=1, sprite gate fails.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x60;             // X=96
  vic.regs[0x01] = 240;
  const yellowRGBA = loadSp0AllOpaque(vic, 0x07);
  vic.regs[0x21] = 0x06;             // bg = blue
  vic.regs[0x20] = 0x0E;             // border = lt blue

  // Drive past display end to render all relevant lines.
  driveTo(vic, 265, 1);

  // Mid-display sanity: L245 should have the sprite painted (24 pixels).
  const cy245 = rasterToCanvasY(245);
  const px245 = countColorOnRow(vic, cy245, yellowRGBA);
  expect(px245 === 24,
    `B2 mid-display: L245 should paint 24 sprite pixels, got ${px245}`);

  // Bottom-border zone L252..L261: all sprite pixels masked.
  for (let r = 252; r <= 261; r++) {
    const cy = rasterToCanvasY(r);
    const n = countColorOnRow(vic, cy, yellowRGBA);
    expect(n === 0,
      `B2: L${r} (bottom border) must have ZERO sprite pixels, got ${n}`);
  }
  ok('B2: sprite Y=240 paints L241..L250; L252..L261 bottom-border zone fully masked');
}

// ─── B3: sprite whose display straddles 311→0 — top-border rows masked ──
//
// Setup: enable sprite only at L311 c50 so the L55 Y-match this frame
// doesn't fire (sprite gets DMA-on at L311 c55 instead). Display ON at
// L0 c58 of the next frame (rule 4 with DMA on + startPending; verified
// by sprite-display-raster-wrap-spec-test S2). L0..L20 are in the top
// vertical border (vBorderActive carries over from L251 onwards).
//
// No DEN trick — vBorder stays SET through the top zone. Sprite pixel
// gate (borderBuffer==0) must fail on L0..L20 → zero sprite pixels.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;             // disabled, will arm at L311 c50
  vic.regs[0x00] = 0x60;             // X=96
  vic.regs[0x01] = 55;               // matches 311 & 0xFF = 55 (and L55 — armed late to skip that)
  const yellowRGBA = loadSp0AllOpaque(vic, 0x07);
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;

  // First-frame: drive past L55 with sprite disabled. Don't enable it
  // yet — we want the L311 wrap to be the first DMA event.
  driveTo(vic, 311, 50);
  vic.regs[0x15] = 0x01;             // arm sprite right before c55

  // Drive across the wrap to L25 (past the 21-line display window
  // that would have started at L0 c58 if rules held).
  driveTo(vic, 25, 1);

  // Sanity: at this point the sprite either painted in L0..L20 (if
  // masking is broken) or it didn't (if masking is correct).
  for (let r = 0; r <= 20; r++) {
    const cy = rasterToCanvasY(r);
    if (cy < 0) continue;
    const n = countColorOnRow(vic, cy, yellowRGBA);
    expect(n === 0,
      `B3: L${r} (top border, vBorder=1) must have ZERO sprite pixels across wrap, got ${n}`);
  }
  ok('B3: sprite Y=55 across 311→0 wrap — top-border zone L0..L20 fully masked');
}

// ─── B2b: sprite Y=240 + DEN-trick opening bottom border — pixels DO show
//
// Opposite control: if the demo OPENS the bottom border (DEN-trick keeps
// vBorder cleared past L251), the same Y=240 sprite paints L241..L261
// throughout. This is the §3.14.1-style positive case that confirms
// B2's masking is from vBorder, not from a faulty sprite render.
//
// Synthetic: force vBorderActive=0 + lineCycle*VBorder=0 across the
// bottom-border lines and re-render.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x60;
  vic.regs[0x01] = 240;
  const yellowRGBA = loadSp0AllOpaque(vic, 0x07);
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;

  driveTo(vic, 250, 0);
  // For L251 and beyond, manually clear vBorder + per-cycle vBorder
  // arrays AFTER each line begins, then re-clock. This isn't a perfect
  // model of the DEN trick but it forces the rendering path to take
  // the "vBorder open" branch.
  let yellowOnBottomBorder = 0;
  for (let r = 251; r <= 261; r++) {
    driveTo(vic, r, 1);
    vic.vBorderActive = false;
    for (let c = 0; c <= CYCLES_PER_LINE; c++) {
      vic.lineCycleVBorder[c] = 0;
      vic.lineCycleVBorderBefore[c] = 0;
    }
    driveTo(vic, r, 62);
    // Force a re-render of this line through the synchronous path.
    vic._renderRasterLine(r);
    const cy = rasterToCanvasY(r);
    const n = countColorOnRow(vic, cy, yellowRGBA);
    yellowOnBottomBorder += n;
  }
  expect(yellowOnBottomBorder > 0,
    `B2b control: with vBorder forced open across L251..L261, sprite Y=240 must paint (got ${yellowOnBottomBorder})`);
  ok('B2b control: open bottom border (vBorder=0 forced) allows sprite Y=240 to paint L251+ pixels');
}

console.log(`\n${testNo} sprite bottom-border + wrap masking spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
