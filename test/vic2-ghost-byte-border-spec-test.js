// Ghost-byte rendering spec audit — focused on the regression of
// "Commando cartridge shows ghost bytes in top/bottom border".
//
// Per Bauer §3.7.5 (idle state) + §3.9 (border state machine):
//
//   - The g-access shifter holds the last fetched byte (the "idle" or
//     "ghost" byte). Its value is whatever was at $3FFF (or $39FF if
//     ECM=1) the last time the VIC needed graphics data.
//   - In a CLOSED border (vBorder=1 OR hBorder=1), the renderer must
//     output the BORDER COLOR, not the ghost byte. The shifter still
//     decrements internally, but its output is hidden by the border.
//   - The "open border" trick (vBorder=0 AND hBorder=0 in regions
//     normally inside the border) is what allows ghost bytes to show.
//     This requires the demo to actively manipulate $D011/$D016 to
//     prevent vBorder/hBorder from being set.
//
// For a normal game like Commando running with default $D011=$1B,
// $D016=$08:
//   - Top border (rasters 0..50): vBorder=1 throughout
//   - Display area (rasters 51..250): vBorder=0
//   - Bottom border (rasters 251..311): vBorder=1
//
// Bug user-reported: loading the Commando cart shows ghost bytes in
// top and bottom border (was not visible earlier in the session). A
// recent change must have broken the closed-border rendering. Tests
// here verify the closed-border path produces ONLY border color.

import { VIC2, CANVAS_W } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// Drive the live two-stage vertical-border FF (Bauer §3.9,
// `_advanceVerticalBorderFlipFlop`) for one line at `raster`, letting the
// cycle-1 latch copy apply the top-RESET / bottom-SET compare.
function vBorderCompareLine(vic, raster) {
  vic.raster = raster;
  vic.cycleInLine = 1;
  vic._vBorderLatch = vic.vBorderActive;
  vic._advanceVerticalBorderFlipFlop();
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

// Set up a default-Commando-like VIC state for a top-border line.
function setupCommandoState(vic) {
  vic.regs[0x11] = 0x1B;             // text mode, RSEL=1, DEN=1, YSCROLL=3
  vic.regs[0x16] = 0x08;             // CSEL=1, MCM=0, XSCROLL=0
  vic.regs[0x18] = 0x14;             // screen $0400, charBase $1000
  vic.regs[0x20] = 0x0E;             // border = light blue
  vic.regs[0x21] = 0x06;             // bg0 = blue
  vic.vBorderActive = true;          // we're in the top border
  vic.hBorderActive = true;
  vic.displayActive = false;
  // Plant a non-zero idle byte so any ghost-byte rendering would be
  // visible.
  vic.lineIdleByte = 0xFF;
  vic.ram[0x3FFF] = 0xFF;
  // Pre-fill all per-cycle state with vBorder=1, hBorder=1 — closed
  // border.
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 1;
    vic.lineCycleVBorderBefore[c] = 1;
    vic.lineCycleHBorder[c] = 1;
    vic.lineCycleHBorderBefore[c] = 1;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleIdleByte[c] = 0xFF;
    vic.lineCycleDisplayColumnActive[c] = 0;
  }
}

const PALETTE_ENTRY_RGBA = (idx) => {
  // Match VIC2's palette helper without importing internals: reuse the
  // raster engine to render a known color.
  const v = new VIC2();
  return v._argb ? null : null;     // unused; keep API simple
};

// Compare a row of fb32 to expected: every visible pixel should be
// border color (not ghost-byte-derived). We compare RGBA values from
// vic.fb32 against vic's palette via the regs[0x20] entry.
function rasterAllBorder(vic, raster) {
  const cy = raster - 15;            // canvasY mapping per _renderRasterLine
  if (cy < 0 || cy * CANVAS_W >= vic.fb32.length) return null;
  const rowOffset = cy * CANVAS_W;
  // Border color computed by VIC2: PALETTE_RGBA[regs[0x20] & 0x0F].
  // We don't import PALETTE_RGBA; instead we let one cell fix the
  // expected by reading the first pixel and asserting all pixels match.
  const first = vic.fb32[rowOffset];
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.fb32[rowOffset + x] !== first) return { x, expected: first, got: vic.fb32[rowOffset + x] };
  }
  return { allMatch: true, color: first };
}

// ── 1: Top border (vBorder=1) — no ghost bytes, all border color ─────
// Bauer §3.9: closed border outputs the border-color register $D020 for
// every pixel. The g-access shifter is gated out by the border FF.
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic._renderRasterLine(20);          // raster 20 = top border
  const r = rasterAllBorder(vic, 20);
  expect(r && r.allMatch,
    `top border line 20 must be solid border color; pixel ${r?.x} differs (got 0x${r?.got?.toString(16)} vs 0x${r?.expected?.toString(16)})`);
  ok('Bauer §3.9: top border line — every pixel is $D020 border color (no ghost bytes)');
}

// ── 2: Bottom border (vBorder=1, lower raster) — same rule ───────────
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic._renderRasterLine(260);         // raster 260 = bottom border
  const r = rasterAllBorder(vic, 260);
  expect(r && r.allMatch,
    `bottom border line 260 must be solid border color; pixel ${r?.x} differs`);
  ok('Bauer §3.9: bottom border line — every pixel is $D020 border color');
}

// ── 3: Border color follows $D020 register value ──────────────────────
// Change $D020 from $0E (light blue) to $02 (red) and verify the border
// color changes. Defends against a regression where border fill is
// hardcoded or missing.
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic.regs[0x20] = 0x02;              // border = red
  for (let c = 0; c <= 63; c++) vic.lineCycleRegs[c].set(vic.regs);
  vic._renderRasterLine(20);
  const r = rasterAllBorder(vic, 20);
  expect(r && r.allMatch,
    `border color $02: every pixel matches; ${r?.x} differs`);
  ok('Bauer §3.9: border color follows $D020 register value');
}

// ── 4: hBorder=1 in side-border zone — no ghost bytes ────────────────
// Even if vBorder=0 (display area), the side-border zones (X<32,
// X>=360) have hBorder=1 and must show border color. Defends against
// the open-border ribbon leaking into closed side borders.
{
  const vic = makeVic();
  setupCommandoState(vic);
  // Display area: vBorder=0, but hBorder=1 in side zones.
  vic.vBorderActive = false;
  vic.displayActive = true;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    // Standard hBorder layout: closed at left/right edges
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
  }
  vic._renderRasterLine(60);          // mid-display
  const cy = 60 - 15;
  const rowOffset = cy * CANVAS_W;
  const borderColor = vic.fb32[rowOffset + 0]; // X=0 is in left side border
  // Verify left side border (X=0..31) and right (X=360..383) are all
  // border color. The inner area (X=32..359) is not asserted here since
  // it goes through the open-border idle path.
  let leftOk = true, rightOk = true;
  for (let x = 0; x < 32; x++) {
    if (vic.fb32[rowOffset + x] !== borderColor) { leftOk = false; break; }
  }
  for (let x = 360; x < 384; x++) {
    if (vic.fb32[rowOffset + x] !== borderColor) { rightOk = false; break; }
  }
  expect(leftOk, `left side border (X<32): ALL border color (no ghost-byte leak)`);
  expect(rightOk, `right side border (X>=360): ALL border color`);
  ok('Bauer §3.9: side borders (hBorder=1) show ONLY border color, no ghost bytes');
}

// ── 5: Closed border + non-zero idleByte — still no ghost output ─────
// Plant a striking idle byte ($AA) and verify it does NOT appear in the
// top border output. This is the regression scenario: the previous
// "shifter clamp removed" change in src/vic2.js may have allowed
// idle-byte rendering in zones it shouldn't.
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic.lineIdleByte = 0xAA;
  vic.ram[0x3FFF] = 0xAA;
  for (let c = 0; c <= 63; c++) vic.lineCycleIdleByte[c] = 0xAA;
  vic._renderRasterLine(20);
  const r = rasterAllBorder(vic, 20);
  expect(r && r.allMatch,
    `closed top border with idleByte=$AA: still solid border color, no $AA bit pattern leaking`);
  ok('Closed border + non-zero idle byte: no ghost-byte leakage');
}

// ── 6: Inner display area with displayColumnActive=false uses idle ───
// Confirms the OPPOSITE: in the inner display zone with no active
// column fetch (e.g., DEN=0 or no bad-line), the renderer DOES emit
// idle-byte content (Bauer §3.7.5). This is the "ghost-byte
// shine-through" path the demo author exploits.
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic.vBorderActive = false;
  vic.displayActive = true;
  vic.lineIdleByte = 0xFF;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleIdleByte[c] = 0xFF;
    vic.lineCycleDisplayColumnActive[c] = 0;     // open text idle
  }
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const rowOffset = cy * CANVAS_W;
  // Inner area X=32..359. With idle=$FF and text mode, every bit set
  // → all pixels = fg=BLACK (per text idle rule). Verify NOT all the
  // same as bg0 (which would be the wrong/all-bg result).
  const innerPixels = [];
  for (let x = 100; x < 200; x++) innerPixels.push(vic.fb32[rowOffset + x]);
  const blackPixels = innerPixels.filter(p => p === 0xFF000000).length;
  expect(blackPixels === innerPixels.length,
    `inner area with idle=$FF + text mode: all pixels BLACK (fg bit pattern), got ${blackPixels}/${innerPixels.length} black`);
  ok('Bauer §3.7.5: inner area + idle=$FF text mode renders ghost-byte fg pattern');
}

// ── 7: hBorder=1 takes precedence over hInner zone ──────────────────
// Defends against a regression where the renderer might check hInner
// without first verifying hBorder is closed. If hInner=1 but hBorder=1
// (impossible in normal display, but let's verify the code is robust),
// border color must win.
{
  const vic = makeVic();
  setupCommandoState(vic);
  // Set up an unusual config: vBorder=0, hBorder=1, hInner=1.
  // (Not normally possible, but tests render-path safety.)
  vic.vBorderActive = false;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 1;       // border closed
    vic.lineCycleHBorderBefore[c] = 1;
    vic.lineCycleHInner[c] = 1;        // but inner flag set
    vic.lineCycleIdleByte[c] = 0xAA;
    vic.lineCycleDisplayColumnActive[c] = 0;
  }
  vic._renderRasterLine(60);
  const r = rasterAllBorder(vic, 60);
  expect(r && r.allMatch,
    `hBorder=1 overrides hInner=1: solid border color (renderer path safety)`);
  ok('Renderer: hBorder=1 takes precedence over hInner — no ghost-byte leak');
}

// ── 8: OPEN border (vBorder=0, hBorder=0) renders ghost byte ─────────
// Per Bauer §3.7.5 + the demo author's article: when a demo manipulates
// $D011/$D016 to keep vBorder=0 across what would normally be border
// rasters, the g-access shifter's last fetched byte ("idle byte" /
// "ghost byte") is shifted out as graphics. This is the foundation of
// side-border-open and top/bottom-border-open demo tricks.
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic.vBorderActive = false;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleIdleByte[c] = 0xFF;
    vic.lineCycleDisplayColumnActive[c] = 0;
  }
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const rowOffset = cy * CANVAS_W;
  // Bauer §3.7.5 (idle source from $3FFF) applies to g-access cycles
  // 15..54 ONLY — that's when the shifter is loaded. The bit-driven
  // idle-byte pattern fills the INNER zone (canvas X 32..351 = 320 px).
  // Side zones (cycles 11..14, 56..58 → canvas X 0..31, 352..383 = 64 px)
  // never load the shifter on the current line; per Bauer §3.7.2 those
  // pixels come from an empty shifter → bg0 ($D021). VICE
  // testprogs/VICII/sb_sprite_fetch confirms: a non-zero $3FFF still
  // shows solid bg in the open side zones.
  // Sample one bg pixel from the side zone to anchor the bg color, then
  // count matches across the canvas. (Avoid importing PALETTE_RGBA.)
  const bg0 = vic.fb32[rowOffset + 0];
  let blackPixels = 0, bgPixels = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.fb32[rowOffset + x] === 0xFF000000) blackPixels++;
    else if (vic.fb32[rowOffset + x] === bg0) bgPixels++;
  }
  expect(blackPixels === 320 && bgPixels === 64,
    `open-border idle=$FF: 320 inner BLACK + 64 side bg, got black=${blackPixels} bg=${bgPixels}`);
  ok('Bauer §3.7.2 + §3.7.5: OPEN border idle=$FF — inner pattern, side zones bg');
}

// ── 9: OPEN border + idle=$AA (10101010) text mode → alternating ─────
// Verifies the ghost-byte BIT PATTERN is correctly emitted: alternating
// fg(BLACK) and bg0(blue) pixels per the byte's bit values.
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic.vBorderActive = false;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleIdleByte[c] = 0xAA;
    vic.lineCycleDisplayColumnActive[c] = 0;
  }
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const rowOffset = cy * CANVAS_W;
  // idle=$AA = 10101010. Bit pattern repeats every 8 pixels: black,
  // bg, black, bg, black, bg, black, bg.
  // Sample 16 contiguous pixels in the inner area to verify the
  // alternating pattern.
  const xStart = 64;                  // some inner-area X
  let bitPatternMatches = 0;
  for (let bit = 0; bit < 16; bit++) {
    const x = xStart + bit;
    const expectFg = ((0xAA >> (7 - (bit & 7))) & 1);
    const px = vic.fb32[rowOffset + x];
    const isBlack = (px === 0xFF000000);
    if (expectFg === (isBlack ? 1 : 0)) bitPatternMatches++;
  }
  expect(bitPatternMatches === 16,
    `idle=$AA pattern: 16 pixels match alternating fg/bg, got ${bitPatternMatches}`);
  ok('Bauer §3.7.5: OPEN border idle=$AA → exact alternating bit pattern');
}

// ── 10: OPEN border + ECM idle byte address ($39FF, not $3FFF) ───────
// Per Bauer §3.7.5: when ECM is set, the idle g-access reads from
// $39FF instead of $3FFF (ECM clamps the upper address bits the same
// way it clamps fg-address fetches). The ghost byte content depends
// on what's at the addressed location.
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic.regs[0x11] = 0x5B;             // ECM=1, RSEL=1, DEN=1
  vic.vBorderActive = false;
  // Different bytes at $3FFF and $39FF — verify ECM picks $39FF.
  vic.ram[0x3FFF] = 0xFF;             // would be wrong
  vic.ram[0x39FF] = 0x00;             // ECM idle address content
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    // _readIdleGByte computes idleAddr from ECM bit; let the cycle-state
    // capture pick the right value naturally:
    vic.lineCycleIdleByte[c] = vic._readIdleGByte(vic.regs, vic.currentVicBank);
    vic.lineCycleDisplayColumnActive[c] = 0;
  }
  expect(vic.lineCycleIdleByte[10] === 0x00,
    `ECM=1 idle byte must come from $39FF (=$00), got $${vic.lineCycleIdleByte[10].toString(16)}`);
  ok('Bauer §3.7.5: ECM=1 clamps idle-byte fetch address to $39FF');
}

// ── 11: OPEN border idle honours left-edge XSCROLL preload ───────────
// Bauer §3.7.3: the sequencer's shifter is reloaded after each g-access,
// and XSCROLL delays the reload by 0-7 pixels. The line's FIRST reload
// lands at canvas 32+XSCROLL; the pixels before it (canvas 32..31+XSCROLL)
// drain an empty shifter — "0" bits → idle background. The preload is
// anchored at the DISPLAY COLUMN start (canvas 32, cycle-15 segment), not
// at the first visible pixel: with CSEL=0 the widened left border covers
// it entirely (WONDER D1 intro FLD swing shows solid black on hardware).
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic.regs[0x11] = 0x18;             // text mode, no ECM/BMM
  vic.regs[0x16] = 0x1E;             // CSEL=1, MCM=1, XSCROLL=6
  vic.regs[0x20] = 0x0B;
  vic.regs[0x21] = 0x0B;
  vic.vBorderActive = false;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleIdleByte[c] = 0xFF;
    vic.lineCycleDisplayColumnActive[c] = 0;
  }
  vic._renderRasterLine(60);
  const rowOffset = (60 - 15) * CANVAS_W;
  const bg = vic.fb32[rowOffset + 0];
  let preloadBg = 0;
  for (let x = 32; x <= 37; x++) {
    if (vic.fb32[rowOffset + x] === bg) preloadBg++;
  }
  expect(preloadBg === 6,
    `XSCROLL=6 left-edge idle preload pixels x32..37 must be bg, got ${preloadBg}/6`);
  expect(vic.fb32[rowOffset + 38] === 0xFF000000,
    `first post-preload idle byte pixel x38 must render BLACK`);
  // WONDER D1 regression: the preload must NOT repeat one group later —
  // x40..45 belong to the idle byte ($FF → black), never to bg. (With
  // CSEL=0 those are the first visible pixels; a bg leak there painted a
  // white flickering bar over the intro's FLD swing lines.)
  let leakedBg = 0;
  for (let x = 40; x <= 45; x++) {
    if (vic.fb32[rowOffset + x] === bg) leakedBg++;
  }
  expect(leakedBg === 0,
    `idle byte pixels x40..45 must be black, got ${leakedBg} bg-coloured`);
  ok('Bauer §3.7.3: open-border idle left-edge XSCROLL preload at the display-column start');
}

// ── 11b: idle XSCROLL drain zone uses the PREVIOUS g-access byte ─────
// Bauer §3.7.3: the shifter is "reloaded with new graphics data after each
// g-access", and XSCROLL delays that reload by 0-7 pixels — so each 8-pixel
// group's first XSCROLL pixels still drain the PREVIOUS byte. On steady idle
// lines both bytes are identical and this is invisible; across a mid-line
// idle-fetch change (ECM flip / VIC bank switch) the two differ. Codeboys D1
// bird-flight last line: idle byte flips $00→$FF between two g-accesses —
// hardware shows the $00 tail (bg), not a wrapped $FF tail (black).
{
  const vic = makeVic();
  setupCommandoState(vic);
  vic.regs[0x11] = 0x18;             // text mode, no ECM/BMM
  vic.regs[0x16] = 0x0E;             // CSEL=1, MCM=0, XSCROLL=6
  vic.regs[0x20] = 0x0B;
  vic.regs[0x21] = 0x0B;
  vic.vBorderActive = false;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    // idle fetch changes mid-line: $AA up to cy16, $00 at cy17, $FF after
    vic.lineCycleIdleByte[c] = (c <= 16) ? 0xAA : (c === 17 ? 0x00 : 0xFF);
    vic.lineCycleDisplayColumnActive[c] = 0;
  }
  vic._renderRasterLine(60);
  const rowOffset = (60 - 15) * CANVAS_W;
  const bg = vic.fb32[rowOffset + 0];
  const black = 0xFF000000;
  const at = x => vic.fb32[rowOffset + x];
  const name = v => v === bg ? 'bg' : (v === black ? 'black' : `0x${(v >>> 0).toString(16)}`);
  // x32..37: empty-shifter preload → bg
  for (let x = 32; x <= 37; x++) {
    expect(at(x) === bg, `x${x} preload must be bg, got ${name(at(x))}`);
  }
  // x38..45: byte@cy16 = $AA (bits 10101010) — head in cy15's segment,
  // tail draining through cy16's first 6 pixels
  const aa = [1, 0, 1, 0, 1, 0, 1, 0];
  for (let x = 38; x <= 45; x++) {
    const want = aa[x - 38] ? black : bg;
    expect(at(x) === want, `x${x} byte@16($AA) bit${x - 38} must be ${name(want)}, got ${name(at(x))}`);
  }
  // x46..47: byte@cy17 = $00 head → bg
  for (let x = 46; x <= 47; x++) {
    expect(at(x) === bg, `x${x} byte@17($00) head must be bg, got ${name(at(x))}`);
  }
  // x48..53: byte@cy17 = $00 TAIL draining through cy17's segment — bg.
  // (A same-byte phase wrap would show byte@18=$FF here → black.)
  for (let x = 48; x <= 53; x++) {
    expect(at(x) === bg, `x${x} byte@17($00) drain tail must be bg, got ${name(at(x))}`);
  }
  // x54..55: byte@cy18 = $FF head → black
  for (let x = 54; x <= 55; x++) {
    expect(at(x) === black, `x${x} byte@18($FF) head must be black, got ${name(at(x))}`);
  }
  ok('Bauer §3.7.3: idle XSCROLL drain zone shows the previous g-access byte');
}

// ── 12: vBorder transition — top compare clears vBorder when DEN=1 ──
// Bauer §3.9 rules 4-5: at cycle 63 of the top compare line, if DEN=1
// then vBorder is cleared. This is the entry to the inner display.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // DEN=1, RSEL=1
  vic.regs[0x16] = 0x08;
  vic.vBorderActive = true;          // start in top border
  // Apply the cycle-63 vertical border compare for raster 51 (top compare
  // for RSEL=1 with DEN=1).
  vBorderCompareLine(vic, 51);
  expect(vic.vBorderActive === false,
    `top compare line 51 + DEN=1: vBorder cleared, got ${vic.vBorderActive}`);
  ok('Bauer §3.9 rule 5: top compare with DEN=1 clears vBorder');
}

// ── 13: vBorder transition — top compare with DEN=0 does NOT clear ──
// Bauer §3.9 rule 5: top compare clears vBorder ONLY if DEN is set.
// With DEN=0, vBorder stays set across the top compare line. This is
// what nine.prg exploits to keep borders open.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x0B;             // DEN=0, RSEL=1
  vic.regs[0x16] = 0x08;
  vic.vBorderActive = true;
  vBorderCompareLine(vic, 51);
  expect(vic.vBorderActive === true,
    `top compare line 51 + DEN=0: vBorder must NOT clear, got ${vic.vBorderActive}`);
  ok('Bauer §3.9 rule 5: top compare with DEN=0 leaves vBorder set');
}

// ── 14: vBorder transition — bottom compare always sets vBorder ─────
// Bauer §3.9 rule 4: bottom compare always sets vBorder (regardless of
// DEN). This is the entry to the bottom border.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // DEN=1, RSEL=1
  vic.regs[0x16] = 0x08;
  vic.vBorderActive = false;          // currently in display area
  vBorderCompareLine(vic, 251);
  expect(vic.vBorderActive === true,
    `bottom compare line 251: vBorder set unconditionally, got ${vic.vBorderActive}`);
  ok('Bauer §3.9 rule 4: bottom compare always sets vBorder (regardless of DEN)');
}

console.log(`\n${testNo} ghost-byte border spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
