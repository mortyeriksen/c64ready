// Side-border-open ("hyperscreen") spec audit — tests cover BAUER §3.14.1
// and the interaction of exact-cycle CSEL writes with rules 1/6 of §3.9.
//
// Rules being tested (paraphrased from Bauer 2024):
//
//   §3.9 rule 1: When the X coordinate reaches the RIGHT comparison value,
//                the main border flip-flop is SET (unconditionally).
//   §3.9 rule 6: When the X coordinate reaches the LEFT comparison value
//                AND the vertical border flip-flop is NOT set, the main
//                border flip-flop is RESET.
//   §3.14.1:    "the change from CSEL=1 to CSEL=0 has to be exactly in
//                cycle 56" — to skip the right-edge SET on the current
//                line, leaving the main border flip-flop reset across
//                the right side. Likewise, "the horizontal border can be
//                prevented from turning off by switching from CSEL=0 to
//                CSEL=1 in cycle 17" — to skip the left-edge RESET on
//                the current line, leaving main FF set across the left.
//
// Compare values (Bauer §3.9 H-table):
//        |  CSEL=0  |  CSEL=1
//   Left |  31      |  24
//   Right| 335      | 344
//
// CPU writes land after the VIC's phi1 work for that cycle. Per-cycle render
// uses lineCycleCselComparator captured at cycle start, while the comparator
// rules are checked against Bauer's exact cycle-56 / cycle-17 windows.
//
// Existing tests already cover (do NOT duplicate):
//   border-edge-spec-test.js: cycle alignment of CSEL=1 vs CSEL=0 compares
//   border-timing-precision-spec-test.js: 1-cycle latch + state machine
//   ghost-byte-border-spec-test.js: closed-border ghost-byte gating
//   topborder-rendering-spec-test.js: top-zone open + invalid modes
//   vborder-supremacy-spec-test.js: vBorder=1 forces hBorder=1
//
// This file targets specifically:
//   1-3.  Hyperscreen latch sequence: skip right-set, skip left-reset.
//   4-5.  Multi-line side-border-open band stays consistent.
//   6-13. Ghost-byte rendering in the OPENED side zones across all 8
//         (ECM,BMM,MCM) graphics-mode combinations.
//   14-15. CSEL=0 (38-col) opened side-border zone widths.
//   16-17. Side-border-open + display-active line: inner display still
//         renders text/bitmap; only side zones show ghost-byte.
//   18.   Bauer §3.14.1 last paragraph: side-border-open + vBorder=1
//         (Method 1) → graphics sequencer outputs bg color, NOT idle byte.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.regs[0x11] = 0x1B;        // DEN=1, RSEL=1, YS=3
  vic.regs[0x16] = 0x08;        // CSEL=1
  return vic;
}

const PAL_RGBA = (idx) => (0xFF000000 |
  ((C64_PALETTE[idx] & 0xFF) << 16) |
  (C64_PALETTE[idx] & 0xFF00) |
  ((C64_PALETTE[idx] >> 16) & 0xFF)) >>> 0;

const BLACK = 0xFF000000;

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

function driveTo(vic, raster, cycle = 0) {
  while (vic.raster < raster || (vic.raster === raster && vic.cycleInLine < cycle)) {
    vic.clock(1);
  }
}

// Set per-cycle render inputs for an entire line. Defaults model an
// open-border line with both border FFs reset (vBorder=0, hBorder=0)
// in the inner X range, and hBorder=1 only at the X-edges driven by
// CSEL. The caller can then override the cycles they want to test.
function setupOpenSideBorderLine(vic, opts = {}) {
  const {
    csel = 1,                          // 0 = 38-col, 1 = 40-col
    vBorder = false,                   // matches vBorderActive
    idleByte = 0xFF,
    mode = 0x1B,                       // $D011 default text mode
    d016 = 0x08,                       // CSEL=1, MCM=0
    bgColor = 0x06,                    // $D021 = blue
    borderColor = 0x0E,                // $D020 = light blue
    sideOpen = true,                   // hBorder=0 across whole line
    displayActive = false,
  } = opts;

  vic.regs[0x11] = mode;
  vic.regs[0x16] = d016;
  vic.regs[0x20] = borderColor;
  vic.regs[0x21] = bgColor;

  const left = csel ? 24 : 31;
  const right = csel ? 344 : 335;
  // Canvas-X variant uses +8 offset.
  const leftCanvas = left + 8;
  const rightCanvas = right + 8;

  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorderBefore[c] = vBorder ? 1 : 0;
    vic.lineCycleVBorder[c] = vBorder ? 1 : 0;
    vic.lineCycleCselComparator[c] = csel;
    if (sideOpen) {
      vic.lineCycleHBorderBefore[c] = 0;
      vic.lineCycleHBorder[c] = 0;
    } else {
      const segStart = (c - 12) * 8 + 8;     // canvas X of cycle start
      const segEnd = (c - 11) * 8 + 8;
      // Closed at the side-border zones, open in inner.
      const inLeft = segStart < leftCanvas;
      const inRight = segEnd > rightCanvas;
      vic.lineCycleHBorderBefore[c] = (inLeft || inRight) ? 1 : 0;
      vic.lineCycleHBorder[c] = vic.lineCycleHBorderBefore[c];
    }
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleIdleByte[c] = idleByte;
    vic.lineCycleDisplayColumnActive[c] = displayActive ? 1 : 0;
    vic.lineCycleRowFetchedCols[c].fill(0);
    vic.lineCycleRowCodes[c].fill(0);
    vic.lineCycleRowColors[c].fill(0);
  }
}

// ── 1: Bauer §3.9 rule 1 — right-compare SETS hBorder unconditionally ──
// With CSEL=1 throughout a line, the right-compare at canvas X=352
// (cycle 55 in 6569 timing) MUST set hBorderActive. This is the
// baseline behavior the side-border-open trick subverts.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;          // CSEL=1
  driveTo(vic, 100, 30);
  expect(vic.hBorderActive === false, `pre cycle 55: hBorder open mid-display`);
  // Walk past cycle 55 — right-compare must fire.
  while (vic.cycleInLine !== 55) vic.clock(1);
  vic.clock(1);                    // step into cycle 56
  expect(vic.hBorderActive === true,
    `Bauer §3.9 rule 1: right-compare at canvas X=352 must SET hBorder`);
  ok(`Bauer §3.9 rule 1: right-compare unconditionally sets hBorder (CSEL=1)`);
}

// ── 3: Bauer §3.9 rule 6 — left-compare RESETS hBorder when vBorder=0 ──
// With CSEL=1 throughout a line entered with hBorder closed (line-start
// state) and vBorder=0 (display zone), the left-compare at canvas X=32
// (cycle 14) MUST clear hBorderActive.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 100, 0);
  expect(vic.hBorderActive === true, `start of L100: hBorder closed (line-start)`);
  // Walk past cycle 14 — left-compare must clear.
  while (vic.cycleInLine !== 14) vic.clock(1);
  vic.clock(1);                    // step into cycle 15
  expect(vic.hBorderActive === false,
    `Bauer §3.9 rule 6: left-compare with vBorder=0 must RESET hBorder`);
  ok(`Bauer §3.9 rule 6: left-compare resets hBorder when vBorder=0 (CSEL=1)`);
}

// ── 4: Multi-line side-border-open via continuous CSEL toggle ──────────
// Demos run a tight loop that flips CSEL every line so neither edge
// ever fires. After several lines we expect hBorder=0 throughout.
// We model this by directly populating the per-cycle border state on
// many lines and verifying the renderer treats them as side-open.
{
  const vic = makeVic();
  // Render 8 lines in succession with hBorder=0 across each.
  for (let raster = 60; raster < 68; raster++) {
    setupOpenSideBorderLine(vic, { csel: 1, idleByte: 0x00 });
    vic._renderRasterLine(raster);
  }
  // Sample a side-border pixel (X=10) on raster 64 — should be open
  // (borderBuffer=0).
  const cy = 64 - 15;
  const ro = cy * CANVAS_W;
  expect(vic.borderBuffer[10] === 0,
    `8 consecutive open-side lines: pixel X=10 in left side has borderBuffer=0`);
  expect(vic.borderBuffer[370] === 0,
    `8 consecutive open-side lines: pixel X=370 in right side has borderBuffer=0`);
  ok(`Bauer §3.14.1: hyperscreen band — multi-line side-border-open holds`);
}

// ── 5: hBorder set in side zone overrides hInner — closed sides paint border
// Sanity baseline: with hBorder=1 in side zones (X<32, X≥352) and vBorder=0,
// the renderer paints $D020 in the side zones regardless of idle byte.
// Used as control for the ghost-byte tests below.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { sideOpen: false, idleByte: 0xFF, borderColor: 0x02 });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  // X=0..31: hBorder=1 → border color $02 (red).
  for (const x of [0, 16, 31]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x02),
      `closed-side X=${x}: must be border $02, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  // X=352..383: also hBorder=1 → border color.
  for (const x of [352, 370, 383]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x02),
      `closed-side X=${x}: must be border $02`);
  }
  ok(`Bauer §3.9: closed-side hBorder=1 paints $D020 regardless of idle byte`);
}

// ── 6: Open side-border — side zones output bg, NOT idle-byte content ──
// Bauer §3.7.2 graphics sequencer: side zones (cycles 11..14 left,
// cycles 56..58 right) lie outside the g-access window (cycles 15..54).
// The shifter is never loaded for those cycles on the current line, so
// the open-side-zone pixels come from an empty shifter → bg color,
// regardless of the idle byte at $3FFF. Verified against VICE
// testprogs/VICII/sb_sprite_fetch where $3FFF=$33 and the open side
// zones still show solid $D021 with no stripes.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { mode: 0x1B, d016: 0x08, idleByte: 0xFF, bgColor: 0x06 });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [0, 8, 16, 24, 31]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x06),
      `text mode at X=${x}: open side zone must be bg ($06), got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  for (const x of [352, 360, 376, 383]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x06),
      `text mode at X=${x}: open side zone must be bg ($06)`);
  }
  ok(`Bauer §3.7.2: open side-zone shifter empty → bg color (idle byte ignored on side)`);
}

// ── 7: Open side-border ghost-byte — text mode, idle=$00 → bg color ────
// All bits clear → bg0 ($D021) for every pixel in side zones.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { mode: 0x1B, d016: 0x08, idleByte: 0x00, bgColor: 0x06 });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [0, 16, 31, 352, 370, 383]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x06),
      `text mode + idle=$00 at X=${x}: must be bg0=$06, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok(`Bauer §3.7.5: open side-border + text mode + idle=$00 → all bg0`);
}

// ── 8: Open side-border — MCM mode does NOT alter the empty-shifter bg ──
// MCM=1 + ECM=0 + BMM=0. Side zones still output bg (shifter empty).
// Sanity-check that mode bits don't cause $D022/$D023 (bg1/bg2) or
// fg-from-color-RAM to leak into the side zones — only bg0 ($D021).
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { mode: 0x1B, d016: 0x18, idleByte: 0xAA, bgColor: 0x06 });
  vic.regs[0x23] = 0x04;            // bg2 = purple — must NOT be sampled
  for (let c = 0; c <= 63; c++) vic.lineCycleRegs[c].set(vic.regs);
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [0, 16, 31]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x06),
      `MCM text X=${x}: open side zone must be bg ($06), got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  for (const x of [352, 370, 383]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x06),
      `MCM text X=${x}: open side zone must be bg ($06)`);
  }
  let purplePixels = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.fb32[ro + x] === PAL_RGBA(0x04)) purplePixels++;
  }
  expect(purplePixels === 0,
    `MCM text idle: bg2 ($D023=$04) must NEVER leak into side zones, got ${purplePixels} purple pixels`);
  ok(`Bauer §3.7.2: MCM mode does not change open-side-zone output (still bg)`);
}

// ── 9: Open side-border — ECM mode does NOT alter the empty-shifter bg ─
// ECM=1, BMM=0, MCM=0. Side zones still output bg (shifter empty),
// regardless of $39FF idle byte content. The $39FF read only matters
// for the INNER zone during display-state IDLE — covered by other tests.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { mode: 0x5B, d016: 0x08, idleByte: 0x00, bgColor: 0x06 });
  vic.ram[0x39FF] = 0xFF;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleIdleByte[c] = vic._readIdleGByte(vic.regs, vic.currentVicBank);
  }
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [0, 16, 31, 352, 370, 383]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x06),
      `ECM text + idle=$FF at X=${x}: open side zone must be bg ($06), got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok(`Bauer §3.7.2: ECM mode does not change open-side-zone output (still bg)`);
}

// ── 10: Open side-border — invalid mode 011 outputs BLACK in side ──────
// ECM=1, MCM=1, BMM=0 (invalid). The empty-shifter "background colour" is
// MODE-DEPENDENT: it is the same colour the sequencer emits for a 0 idle
// byte. For the invalid modes that colour is BLACK (Bauer §3.7.3 "three
// invalid combinations generate the color black"; with idle c-data=0 the
// $D021 path is never reached). Verified against VICE: the open border of
// these modes is black edge-to-edge, not $D021.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { mode: 0x5B, d016: 0x18, idleByte: 0x55, bgColor: 0x06 });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [0, 16, 31, 352, 370, 383]) {
    expect(vic.fb32[ro + x] === BLACK,
      `invalid mode 011 at X=${x}: open side zone must be BLACK, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok(`Bauer §3.7.3: invalid mode 011 — open side zone BLACK (idle c-data=0)`);
}

// ── 11: Open side-border — standard bitmap (100) outputs BLACK in side ─
// BMM=1, ECM=0, MCM=0. In standard bitmap (§3.7.3.3) BOTH the "0" and "1"
// colours come from the c-data nibbles (low/high), never from $D021. In
// idle the c-data is 0 (§3.7.3), so the empty-shifter background is BLACK,
// not $D021. Confirmed against the VICE border-250/bm-* references, whose
// hi-res-bitmap open borders are black edge-to-edge.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { mode: 0x3B, d016: 0x08, idleByte: 0xFF, bgColor: 0x06 });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [0, 16, 31, 352, 370, 383]) {
    expect(vic.fb32[ro + x] === BLACK,
      `BMM at X=${x}: open side zone must be BLACK, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok(`Bauer §3.7.3.3: standard bitmap — open side zone BLACK (c-data nibbles=0)`);
}

// ── 12: Open side-border — MCM bitmap (101) still outputs bg in side ───
// BMM=1, MCM=1, ECM=0. Same: side zones empty-shifter → bg.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { mode: 0x3B, d016: 0x18, idleByte: 0xFF, bgColor: 0x06 });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [0, 16, 31, 352, 370, 383]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x06),
      `MCM bitmap at X=${x}: open side zone must be bg ($06), got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok(`Bauer §3.7.2: MCM bitmap — open side zone still bg (shifter empty)`);
}

// ── 13: Open side-border — invalid modes 110/111 output BLACK in side ──
// ECM+BMM (110) and ECM+BMM+MCM (111) are invalid → BLACK (§3.7.3). The
// empty-shifter side-zone background follows the same idle-c-data=0 colour.
{
  for (const d016 of [0x08, 0x18]) {
    const vic = makeVic();
    setupOpenSideBorderLine(vic, { mode: 0x7B, d016, idleByte: 0xFF, bgColor: 0x06 });
    vic._renderRasterLine(60);
    const cy = 60 - 15;
    const ro = cy * CANVAS_W;
    for (const x of [0, 16, 31, 352, 370, 383]) {
      expect(vic.fb32[ro + x] === BLACK,
        `invalid mode (d016=$${d016.toString(16)}) at X=${x}: open side zone must be BLACK`);
    }
  }
  ok(`Bauer §3.7.3: invalid modes 110/111 — open side zone BLACK (idle c-data=0)`);
}

// ── 14: 38-col mode (CSEL=0) — left side-border extends to canvas X=39 ─
// Bauer §3.9 H-table: CSEL=0 left=31 (canvas X=39 with +8 offset). The
// 7 extra pixels (X=32..38) form the 38-col mode's widened left border.
// When opened (hBorder=0 across), these pixels show ghost byte too.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { csel: 0, mode: 0x1B, d016: 0x00, idleByte: 0xFF, bgColor: 0x06 });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  // X=32..38 (the "38-col extra left border" region) must show ghost byte.
  // With idle=$FF text mode, all bits 1 → BLACK fg.
  for (const x of [32, 35, 38]) {
    expect(vic.fb32[ro + x] === BLACK,
      `38-col extra-left X=${x}: open-side ghost byte → BLACK, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok(`Bauer §3.9 + §3.14.1: 38-col mode opened left side reveals X=32..38 as ghost byte`);
}

// ── 15: 38-col mode (CSEL=0) — right side-border extends to canvas X=343
// Bauer §3.9 H-table: CSEL=0 right=335 (canvas X=343). X=343..351 forms
// the widened right border in 38-col mode.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { csel: 0, mode: 0x1B, d016: 0x00, idleByte: 0xFF, bgColor: 0x06 });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [343, 348, 351]) {
    expect(vic.fb32[ro + x] === BLACK,
      `38-col extra-right X=${x}: open-side ghost byte → BLACK`);
  }
  ok(`Bauer §3.9 + §3.14.1: 38-col mode opened right side reveals X=343..351 as ghost byte`);
}

// ── 16: Side-border-open with display ACTIVE — inner shows text, sides bg
// Per Bauer §3.7.2: opening the side border doesn't disable the display;
// the inner X range still renders text/bitmap from c-fetched data. The
// side zones, however, output bg color (empty shifter) — NOT the idle
// byte. The "ghost byte" is only visible to sprites whose data buffer
// happens to read $3FFF during sprite-fetch cycles, which is a separate
// path covered in sprite tests.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { mode: 0x1B, d016: 0x08, idleByte: 0xFF, displayActive: true });
  // Plant text data: char 'A' all-black on bg0=blue, character ROM
  // populated for char code 1 with all-1 row bytes.
  vic.regs[0x21] = 0x06;            // bg = blue
  vic.charRom[8] = 0xFF;            // char 1 row 0 = all foreground
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRowFetchedCols[c][0] = 1;
    vic.lineCycleRowCodes[c][0] = 1;
    vic.lineCycleRowColors[c][0] = 0x07;     // fg = yellow
  }
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  // Inner display column 0 (X=32..39): all FG yellow (color RAM).
  for (const x of [32, 35, 39]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x07),
      `inner display col 0 X=${x}: char fg = yellow, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  // Side-border zone (X<32): bg ($06 blue), NOT idle-byte content.
  for (const x of [0, 16, 31]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x06),
      `left side-zone X=${x} on display-active line: bg ($06), got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok(`Bauer §3.7.2 + §3.14.1: side-border-open + active display → inner=text, sides=bg`);
}

// ── 17: Side-border-open with vBorder=0 — both border buffers cleared ──
// borderBuffer=0 means sprites can paint. Verify that opening the side
// border (with vBorder also 0) clears borderBuffer in the side zones.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { vBorder: false, idleByte: 0x00 });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  let openCount = 0;
  for (let x = 0; x < CANVAS_W; x++) if (vic.borderBuffer[x] === 0) openCount++;
  expect(openCount === CANVAS_W,
    `open side-border + vBorder=0: borderBuffer=0 across full row, got ${openCount}/${CANVAS_W}`);
  ok(`Bauer §3.9 + §3.14.1: open side-border + vBorder=0 → borderBuffer=0 everywhere`);
}

// ── 18: Bauer §3.14.1 Method 1 — side-open + vBorder=1 → bg color, NOT idle
// Quote (last paragraph of §3.14.1):
//   "with the first method, only the background color is visible in the
//    opened up upper/lower border area"
// "First method" = open side border BEFORE vertical-FF is set, then let
// vertical-FF set normally. The main-FF stays reset (because right-set
// trick was applied, and rule 6 left-reset is gated by vBorder=0 — but
// since the main-FF was already reset before vBorder went 1, it stays).
// Per spec the SEQUENCER outputs bg color (gated by vertical-FF), not
// idle byte. This is the behavior the implementation must satisfy.
{
  const vic = makeVic();
  // Open side border with vBorder=1 (we're in upper/lower border zone
  // but main FF is reset because the right-set was previously skipped).
  setupOpenSideBorderLine(vic, { vBorder: true, idleByte: 0xFF, bgColor: 0x06, borderColor: 0x02 });
  // hBorder must remain reset across the line for Method 1.
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
  }
  vic._renderRasterLine(20);     // raster 20 = upper border zone
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // Per Bauer §3.14.1: side-zone pixels MUST be bg color $D021=$06,
  // NOT idle-byte content (BLACK from $FF), NOT border color $02.
  let bgPixels = 0, blackPixels = 0, borderPixels = 0;
  for (let x = 0; x < 32; x++) {
    const px = vic.fb32[ro + x];
    if (px === PAL_RGBA(0x06)) bgPixels++;
    else if (px === BLACK) blackPixels++;
    else if (px === PAL_RGBA(0x02)) borderPixels++;
  }
  expect(bgPixels === 32,
    `Method 1: side-zone X<32 on vBorder=1 line must be bg ($06), got bg=${bgPixels}, black=${blackPixels}, border=${borderPixels}`);
  ok(`Bauer §3.14.1 Method 1: side-open + vBorder=1 → sequencer outputs bg color, not idle`);
}

// ── 19: Bauer §3.14.1 Method 2 — side-open + vBorder=0 (full hyperscreen)
// "the second method displays the idle state graphics there" applies to
// the INNER zone where the idle-state shifter is loaded from $3FFF.
// The side zones (cycles outside 15..54) have an empty shifter on every
// line — Method 2 still shows bg there. Confirmed against VICE
// testprogs/VICII/sb_sprite_fetch where $3FFF=$33 yet open side zones
// stay solid bg with no stripes.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, { vBorder: false, idleByte: 0xFF, bgColor: 0x06 });
  vic._renderRasterLine(20);     // raster 20 = upper border zone (vBorder forced 0 via DEN trick)
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [0, 16, 31, 352, 370, 383]) {
    expect(vic.fb32[ro + x] === PAL_RGBA(0x06),
      `Method 2 hyperscreen X=${x}: side zone must be bg ($06), got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok(`Bauer §3.14.1 Method 2: side-open zone outputs bg (empty shifter), idle byte only in inner`);
}

// ── 20: vBorder supremacy — left-compare CANNOT reset hBorder when vBorder=1
// Bauer §3.9 rule 6: "When the X coordinate reaches the LEFT comparison
// value AND the vertical border flip-flop is NOT set, the main border
// flip-flop is reset." The CONJUNCTION is critical for opening the
// side border in the upper/lower border area: you must open the side
// border FIRST (while vBorder=0) because once vBorder=1, the left-reset
// is blocked. Test: enter line with hBorder=1, vBorder=1, walk past
// left-compare cycle 14, hBorder must STAY 1.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  // Drive into bottom border (vBorder=1).
  driveTo(vic, 260, 0);
  expect(vic.vBorderActive === true, `pre L260: vBorder=1 (bottom border)`);
  expect(vic.hBorderActive === true, `pre L260: hBorder=1 at line start`);
  // Walk past cycle 14 — left-compare fires, but rule 6 conjunction
  // blocks the reset (vBorder=1).
  while (vic.cycleInLine !== 14) vic.clock(1);
  vic.clock(1);
  expect(vic.hBorderActive === true,
    `Bauer §3.9 rule 6: left-compare with vBorder=1 must NOT reset hBorder`);
  ok(`Bauer §3.9 rule 6: vBorder=1 blocks left-compare reset (vertical-FF supremacy)`);
}

// ── Bauer §3.14.1 direction asymmetry — veto fires only on spec direction
// The spec defines exactly two directional CSEL tricks:
//   • Right-prevent (hyperscreen): CSEL=1→0 at cycle 56 → skip right-SET
//   • Left-prevent:                CSEL=0→1 at cycle 17 → skip left-RESET
// The reverse-direction writes (CSEL=0→1 near cy 56, CSEL=1→0 near cy 17)
// are NOT defined tricks. The original X=compareValue pulse "matches
// precisely" once and commits — later CSEL changes don't unfire it.
// nine.prg writes CSEL=1→0 mid-line near cy 16-18 and our veto used to
// fire bidirectionally, closing the entire scanline (full-width black
// stripes). Tests below pin the directional veto behavior.

// ── 19: CSEL=1→0 at cy 16 (nine.prg pattern) MUST NOT veto left-RESET ──
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;            // CSEL=1
  driveTo(vic, 100, 0);
  expect(vic.hBorderActive === true, `start L100: hBorder closed`);
  // Walk to cycle 15 — left-compare (X=24, CSEL=1) fires, hBorder→0.
  while (vic.cycleInLine !== 15) vic.clock(1);
  expect(vic.hBorderActive === false, `cy 15: left-compare opened border`);
  // CPU writes CSEL=0 at cy 16 phi2 (after cycle 16 VIC tick).
  while (vic.cycleInLine !== 16) vic.clock(1);
  vic.write(0x16, 0x00);
  // Step a few more cycles — hBorder must STAY 0 (the X=24 pulse with
  // old CSEL=1 already committed; CSEL=1→0 is not a spec-defined trick).
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.hBorderActive === false,
    `nine.prg: CSEL=1→0 mid-line at cy 16 must NOT re-close left border`);
  ok(`Bauer §3.14.1 direction: CSEL=1→0 near cy 17 leaves left-RESET committed`);
}

// ── 20: CSEL=1→0 at cy 17 (nine.prg pattern) MUST NOT veto left-RESET ──
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;            // CSEL=1
  driveTo(vic, 100, 0);
  while (vic.cycleInLine !== 15) vic.clock(1);
  expect(vic.hBorderActive === false, `cy 15: left-compare opened border`);
  while (vic.cycleInLine !== 17) vic.clock(1);
  vic.write(0x16, 0x00);
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.hBorderActive === false,
    `nine.prg: CSEL=1→0 at cy 17 must NOT re-close left border`);
  ok(`Bauer §3.14.1 direction: CSEL=1→0 at cy 17 leaves left-RESET committed`);
}

// ── 21: CSEL=0→1 at cy 17 (Bauer left-prevent trick) — veto MUST fire ──
// Verifies the spec-defined direction still works after the asymmetry fix.
// Setup: CSEL=0 from line start. Left-compare X=31 fires at cy 15.
// CPU writes CSEL=1 at cy 17 phi2 (= "in cycle 17" per spec). The pending
// left-RESET should be vetoed → border stays CLOSED.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x00;            // CSEL=0
  driveTo(vic, 100, 0);
  expect(vic.hBorderActive === true, `start L100: hBorder closed`);
  // Cycle 15 with CSEL=0: left=31 hits cy 15. hBorder transitions to 0
  // optimistically (pending left-RESET queued for veto window).
  while (vic.cycleInLine !== 15) vic.clock(1);
  expect(vic.hBorderActive === false, `cy 15: left-compare optimistically opens`);
  // CPU writes CSEL=1 at cy 17 phi2.
  while (vic.cycleInLine !== 17) vic.clock(1);
  vic.write(0x16, 0x08);
  // Step further — veto must have fired, hBorder restored to closed.
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.hBorderActive === true,
    `Bauer §3.14.1 left-prevent: CSEL=0→1 at cy 17 vetoes left-RESET`);
  ok(`Bauer §3.14.1 direction: CSEL=0→1 at cy 17 vetoes left-RESET (spec trick)`);
}

// ── 22: CSEL=0→1 at cy 15 retargets the rendered left split ─────────────
// The CSEL=0 left compare is the late edge of cycle 15. A same-cycle phi2
// CSEL=0→1 write retargets the segment-15 render split to the CSEL=1 edge
// (canvas X=32) before that segment is rendered on the next clock. Fairlight
// 1337 uses this path; freezing the split at the stale CSEL=0 edge left
// canvas X=32..38 as border and hid the first text-column pixels.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x00;            // CSEL=0
  driveTo(vic, 100, 0);
  expect(vic.hBorderActive === true, `start L100: hBorder closed`);
  while (vic.cycleInLine !== 15) vic.clock(1);
  expect(vic.hBorderActive === false, `cy 15: CSEL=0 left-compare opens border`);
  expect(vic.lineCycleCselComparator[15] === 0,
    `pre-write: segment-15 split sample starts as CSEL=0`);
  vic.write(0x16, 0x08);            // CSEL=1 at cy15 phi2
  expect(vic.lineCycleCselComparator[15] === 1,
    `cy15 CSEL=0→1 write must retarget segment-15 split sample to CSEL=1`);
  vic.clock(1);                     // cy16 renders segment 15
  const ro = (100 - 15) * CANVAS_W;
  let closed = 0;
  for (let x = 32; x <= 38; x++) if (vic.borderBuffer[x]) closed++;
  expect(closed === 0,
    `cy15 CSEL=0→1 retarget: canvas X=32..38 must be open, got ${closed} closed pixels`);
  ok(`Bauer §3.9 left edge: cy15 CSEL=0→1 retargets rendered split to CSEL=1 edge`);
}

// ── 25: XSCROLL tail continues into an opened right border ──────────────
// VICE keeps the 320-pixel graphics stream intact when XSCROLL moves it
// right: with XSCROLL=1, source pixel 319 lands at canvas X=352. The normal
// border hides that pixel, but the cycle-56 CSEL trick exposes it.
{
  const vic = makeVic();
  setupOpenSideBorderLine(vic, {
    d016: 0x09,                 // CSEL=1, XSCROLL=1
    displayActive: true,
    bgColor: 0x06,
  });
  vic.lineCycleCWriteCol.fill(-1);
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleDisplayActive[c] = 1;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleRowLiveVcBase[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowFetchedCols[c][39] = 1;
    vic.lineCycleRowCodes[c][39] = 1;
    vic.lineCycleRowColors[c][39] = 0x07;
  }
  // Final two pixels of character 1 are foreground yellow. XSCROLL=1 puts
  // bit 1 at X=351 and bit 0 at X=352.
  vic.charRom[8] = 0x03;
  vic._renderRasterLine(60);
  const ro = (60 - 15) * CANVAS_W;
  expect(vic.fb32[ro + 351] === PAL_RGBA(0x07),
    `XSCROLL tail setup: canvas X=351 must show source bit 1, got 0x${vic.fb32[ro + 351].toString(16)}`);
  expect(vic.fb32[ro + 352] === PAL_RGBA(0x07),
    `open right border: XSCROLL=1 source bit 0 must spill to canvas X=352, got 0x${vic.fb32[ro + 352].toString(16)}`);
  expect(vic.fb32[ro + 353] === PAL_RGBA(0x06),
    `XSCROLL=1 spill is exactly one pixel; canvas X=353 remains background`);
  ok(`VICE VIC-II renderer: XSCROLL tail spills into an opened right border`);
}

console.log(`\n${testNo} side-border-open spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
